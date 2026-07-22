/**
 * 工具输出预算中间件 — 限制工具结果的尺寸。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/tool_output_budget_middleware.py
 *
 * 超大的工具结果会被持久化到磁盘，替换为包含文件引用的紧凑预览。
 * 当磁盘持久化不可用时，回退到头+尾截断。
 *
 * 为什么需要这个？
 * 一个 web_search 可能返回 100KB 的搜索结果，一个 read_file 可能读取 500KB 的文件。
 * 如果全部塞进 LLM 上下文，Token 会爆炸。
 * 这个中间件把超大结果"存到文件，给 LLM 一个摘要 + 文件路径"。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename, resolve, isAbsolute, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { type Sandbox } from "../../sandbox/sandbox.js";
import { getSandboxProvider } from "../../sandbox/sandbox_provider.js";
import { getAppConfig } from "../../config/app_config.js";
import { type ToolOutputConfig } from "../../config/tool_output_config.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 沙箱内虚拟 outputs 根路径。宿主挂载的沙箱会把这个路径映射到线程 outputs 目录。 */
const _VIRTUAL_OUTPUTS_BASE = "/mnt/user-data/outputs";

/** 工具名 → 扩展名映射 */
const _EXT_MAP: Record<string, string> = {
    bash: "log",
    bash_tool: "log",
    web_fetch: "log",
};

/** 默认配置（当 config 加载失败时使用） */
function _defaultConfig(): ToolOutputConfig {
    return {
        enabled: true,
        externalize_min_chars: 10000,
        preview_head_chars: 3000,
        preview_tail_chars: 1000,
        fallback_max_chars: 20000,
        fallback_head_chars: 4000,
        fallback_tail_chars: 1000,
        storage_subdir: "tool-output",
        exempt_tools: [],
        tool_overrides: {},
    } as ToolOutputConfig;
}

// ════════════════════════════════════════════════════════════════════════════════
// 文本辅助
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从 ToolMessage 的 content 中提取纯文本。
 *
 * 支持 string / null / content blocks 数组。
 * 非文本内容（图片等）返回 null，跳过预算检查。
 */
function _messageText(content: unknown): string | null {
    if (typeof content === "string") return content;
    if (content === null || content === undefined) return null;
    if (Array.isArray(content)) {
        const pieces: string[] = [];
        for (const part of content) {
            if (typeof part === "string") {
                pieces.push(part);
            } else if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
                pieces.push((part as Record<string, unknown>).text as string);
            } else {
                return null;
            }
        }
        return pieces.length > 0 ? pieces.join("\n") : null;
    }
    return null;
}

/**
 * 将位置向前对齐到最近的换行符。
 * 用于结束位置——往前缩短切片。
 */
function _snapToLineBoundary(text: string, pos: number): number {
    if (pos <= 0 || pos >= text.length) return pos;
    const half = Math.floor(pos / 2);
    const nl = text.lastIndexOf("\n", half + pos > text.length ? pos : half);
    if (nl >= 0) return nl + 1;
    return pos;
}

/**
 * 将位置向后对齐到最近的换行符。
 * 用于起始位置——往后保证不拉长切片。
 */
function _snapStartToLineBoundary(text: string, pos: number): number {
    if (pos <= 0 || pos >= text.length) return pos;
    const half = pos + Math.floor((text.length - pos) / 2);
    const nl = text.indexOf("\n", pos);
    if (nl >= 0 && nl < half) return nl + 1;
    return pos;
}

// ════════════════════════════════════════════════════════════════════════════════
// 文件名辅助
// ════════════════════════════════════════════════════════════════════════════════

function _sanitizeToolName(name: string): string {
    const base = basename(name);
    return base.replace(/\.\./g, "").replace(/[/\\]/g, "_") || "unknown";
}

function _buildExternalizedFilename(toolName: string, toolCallId: string): string {
    const safe = _sanitizeToolName(toolName);
    const ext = _EXT_MAP[toolName] ?? "txt";
    const shortId = randomUUID().replace(/-/g, "").slice(0, 12);
    return `${safe}-${shortId}.${ext}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// 磁盘持久化
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 将内容写入宿主磁盘，返回虚拟路径。
 * 失败时返回 null，调用方回退到内联截断。
 */
function _externalize(
    content: string,
    options: {
        toolName: string;
        toolCallId: string;
        outputsPath: string;
        storageSubdir: string;
    },
): string | null {
    const { toolName, toolCallId, outputsPath, storageSubdir } = options;

    // 安全校验：防止路径遍历
    if (isAbsolute(storageSubdir) || storageSubdir.includes("..")) return null;

    const storageDir = join(outputsPath, storageSubdir);
    try {
        mkdirSync(storageDir, { recursive: true });
    } catch {
        return null;
    }

    const filename = _buildExternalizedFilename(toolName, toolCallId);
    const filepath = join(storageDir, filename);

    // 确保文件在预期的存储目录下（路径遍历二次校验）
    if (!resolve(filepath).startsWith(resolve(storageDir))) return null;

    try {
        writeFileSync(filepath, content, "utf-8");
    } catch {
        return null;
    }

    return `${_VIRTUAL_OUTPUTS_BASE}/${storageSubdir}/${filename}`;
}

/**
 * 将内容写入沙箱文件系统，返回虚拟路径。
 * 当沙箱不使用线程数据挂载时使用（如远程 AIO 沙箱）。
 */
async function _externalizeToSandbox(
    content: string,
    options: {
        toolName: string;
        toolCallId: string;
        storageSubdir: string;
        sandbox: Sandbox;
    },
): Promise<string | null> {
    const { toolName, toolCallId, storageSubdir, sandbox } = options;

    if (isAbsolute(storageSubdir) || storageSubdir.includes("..")) return null;

    const filename = _buildExternalizedFilename(toolName, toolCallId);
    const virtualDir = `${_VIRTUAL_OUTPUTS_BASE}/${storageSubdir}`;
    const virtualPath = `${virtualDir}/${filename}`;

    try {
        // AIO 沙箱 writeFile 不会自动创建父目录，所以先创建
        await sandbox.executeCommand(`mkdir -p ${virtualDir}`);
        await sandbox.writeFile(virtualPath, content);

        // 验证文件确实写入了
        const check = await sandbox.executeCommand(`test -s ${virtualPath} && echo OK || echo MISSING`);
        if (!check || check.trim() !== "OK") {
            return null;
        }
    } catch {
        return null;
    }

    return virtualPath;
}

// ════════════════════════════════════════════════════════════════════════════════
// 预览 / 回退构建器
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 构建包含文件引用的紧凑预览。
 *
 * 格式：
 *   文件头几行
 *   [Full {tool_name} output saved to {path} ({total} chars, ~{tokens} tokens)...]
 *   文件尾几行
 */
function _buildPreview(
    content: string,
    options: {
        toolName: string;
        virtualPath: string;
        headChars: number;
        tailChars: number;
    },
): string {
    const { toolName, virtualPath, headChars, tailChars } = options;
    const total = content.length;

    const headEnd = _snapToLineBoundary(content, Math.min(headChars, total));
    const tailStartRaw = Math.max(headEnd, total - tailChars);
    const tailStart = _snapToLineBoundary(content, tailStartRaw);
    const tailStartFinal = tailStart > headEnd ? tailStart : headEnd;

    const head = content.slice(0, headEnd);
    const tail = tailStartFinal < total ? content.slice(tailStartFinal) : "";

    const omitted = total - head.length - tail.length;
    const tokens = Math.max(1, Math.floor(total / 4));
    const ref = `\n\n[Full ${toolName} output saved to ${virtualPath} (${total} chars, ~${tokens} tokens). Use read_file with start_line and end_line to access specific sections. ${omitted} chars omitted from this preview.]\n\n`;

    const parts = [head, ref];
    if (tail) parts.push(tail);
    return parts.join("");
}

/**
 * 构建头+尾截断的降级内容（磁盘持久化不可用时）。
 */
function _buildFallback(
    content: string,
    options: {
        toolName: string;
        maxChars: number;
        headChars: number;
        tailChars: number;
    },
): string {
    const { toolName, maxChars, headChars, tailChars } = options;
    const total = content.length;

    if (maxChars <= 0 || total <= maxChars) return content;

    const markerTemplate = `\n\n[... {n} chars omitted from {tn} output. Persistent storage unavailable. Consider narrowing the query or using more specific parameters.]\n\n`;
    const markerText = markerTemplate.replace("{n}", String(total)).replace("{tn}", toolName);
    const markerOverhead = markerText.length;

    if (markerOverhead >= maxChars) return content.slice(0, maxChars);

    const budget = maxChars - markerOverhead;
    const effectiveHead = Math.min(headChars, budget);
    const effectiveTail = Math.min(tailChars, Math.max(0, budget - effectiveHead));

    const headEnd = _snapToLineBoundary(content, Math.min(effectiveHead, total));
    const tailStartRaw = Math.max(headEnd, total - effectiveTail);
    const tailStart = _snapStartToLineBoundary(content, tailStartRaw);

    const head = content.slice(0, headEnd);
    const tail = tailStart < total ? content.slice(tailStart) : "";
    const omitted = total - head.length - tail.length;

    const marker = markerTemplate.replace("{n}", String(omitted)).replace("{tn}", toolName);
    const parts = [head, marker];
    if (tail) parts.push(tail);
    return parts.join("");
}

// ════════════════════════════════════════════════════════════════════════════════
// 运行时解析
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从运行时状态中提取线程 outputs 路径。
 */
function _resolveOutputsPath(state: Record<string, unknown> | null | undefined): string | null {
    if (!state) return null;
    const threadData = state.thread_data as Record<string, unknown> | undefined;
    if (!threadData) return null;
    const outputsPath = threadData.outputs_path;
    return typeof outputsPath === "string" ? outputsPath : null;
}

/**
 * 从运行时状态中解析当前沙箱。
 */
function _resolveSandbox(state: Record<string, unknown> | null | undefined): Sandbox | null {
    if (!state) return null;
    const sandboxState = state.sandbox as Record<string, unknown> | undefined;
    if (!sandboxState) return null;
    const sandboxId = sandboxState.sandbox_id as string | undefined;
    if (!sandboxId) return null;
    try {
        return getSandboxProvider().then((p) => p.get(sandboxId) ?? null) as unknown as Sandbox | null;
    } catch {
        return null;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 核心预算逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 对 content 应用预算限制。
 *
 * 决策链：
 *   1. 如果内容超过 externalize 阈值 → 持久化到磁盘 → 返回预览
 *   2. 如果持久化失败且内容超过 fallback 阈值 → 头+尾截断
 *   3. 否则 → 返回 null（不需要处理）
 *
 * @returns 处理后的内容，或 null（无需处理）
 */
async function _budgetContent(
    content: string,
    options: {
        toolName: string;
        toolCallId: string;
        outputsPath: string | null;
        config: ToolOutputConfig;
        sandbox: Sandbox | null;
    },
): Promise<string | null> {
    const { toolName, toolCallId, outputsPath, config, sandbox } = options;

    const threshold = (config.tool_overrides as Record<string, number> | undefined)?.[toolName]
        ?? config.externalize_min_chars ?? 10000;

    if (threshold <= 0 && (config.fallback_max_chars ?? 0) <= 0) return null;
    if (content.length <= threshold && content.length <= (config.fallback_max_chars ?? Infinity)) return null;

    // 尝试持久化到磁盘
    if (threshold > 0 && content.length > threshold && sandbox) {
        let virtualPath: string | null = null;

        try {
            const provider = await getSandboxProvider();
            const usesMounts = (provider as unknown as Record<string, unknown>).uses_thread_data_mounts === true;

            if (usesMounts && outputsPath) {
                // 宿主挂载的沙箱：写宿主路径等价于写沙箱
                virtualPath = _externalize(content, {
                    toolName,
                    toolCallId,
                    outputsPath,
                    storageSubdir: config.storage_subdir ?? "tool-output",
                });
            } else {
                // 远程沙箱：直接写入沙箱文件系统
                virtualPath = await _externalizeToSandbox(content, {
                    toolName,
                    toolCallId,
                    storageSubdir: config.storage_subdir ?? "tool-output",
                    sandbox,
                });
            }
        } catch {
            // 持久化失败，回退到截断
        }

        if (virtualPath) {
            return _buildPreview(content, {
                toolName,
                virtualPath,
                headChars: config.preview_head_chars ?? 3000,
                tailChars: config.preview_tail_chars ?? 1000,
            });
        }
    }

    // 回退：内存中截断
    if ((config.fallback_max_chars ?? 0) > 0 && content.length > (config.fallback_max_chars!)) {
        return _buildFallback(content, {
            toolName,
            maxChars: config.fallback_max_chars!,
            headChars: config.fallback_head_chars ?? 4000,
            tailChars: config.fallback_tail_chars ?? 1000,
        });
    }

    return null;
}

/**
 * 对单条 ToolMessage 应用预算。
 */
async function _patchToolMessage(
    msg: Record<string, unknown>,
    config: ToolOutputConfig,
    outputsPath: string | null,
    sandbox: Sandbox | null,
): Promise<Record<string, unknown>> {
    const toolName = (msg.name as string) ?? "unknown";

    // 豁免工具
    const exemptTools = config.exempt_tools ?? [];
    if (exemptTools.includes(toolName)) return msg;

    const text = _messageText(msg.content);
    if (text === null) return msg;

    const replacement = await _budgetContent(text, {
        toolName,
        toolCallId: (msg.tool_call_id as string) ?? "",
        outputsPath,
        config,
        sandbox,
    });

    if (replacement === null) return msg;

    return { ...msg, content: replacement };
}

/**
 * 快速检查结果是否需要预算处理（避免为小输出做不必要的开销）。
 */
function _needsBudget(
    msg: Record<string, unknown>,
    config: ToolOutputConfig,
): boolean {
    if (config.enabled === false) return false;
    const toolName = (msg.name as string) ?? "";
    const exemptTools = config.exempt_tools ?? [];
    if (exemptTools.includes(toolName)) return false;

    const threshold = (config.tool_overrides as Record<string, number> | undefined)?.[toolName]
        ?? config.externalize_min_chars ?? 10000;

    const fallbackMax = config.fallback_max_chars ?? 20000;
    if (threshold <= 0 && fallbackMax <= 0) return false;

    const text = _messageText(msg.content);
    if (text === null) return false;

    return text.length > Math.min(threshold > 0 ? threshold : Infinity, fallbackMax > 0 ? fallbackMax : Infinity);
}

// ════════════════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 对工具调用结果应用输出预算。
 *
 * 在工具执行完成后调用。
 *
 * @param msg 工具消息（ToolMessage 的数据）
 * @param runtimeState 运行时状态（用于提取 outputs 路径和沙箱）
 * @param appConfig 可选 AppConfig（测试注入用）
 * @returns 处理后的消息
 */
export async function applyToolOutputBudget(
    msg: Record<string, unknown>,
    runtimeState?: Record<string, unknown> | null,
    appConfig?: unknown,
): Promise<Record<string, unknown>> {
    let config: ToolOutputConfig;
    try {
        const cfg = appConfig ?? getAppConfig();
        const toolOutput = (cfg as Record<string, unknown>).tool_output as ToolOutputConfig | undefined;
        config = toolOutput ?? _defaultConfig();
    } catch {
        config = _defaultConfig();
    }

    if (!config.enabled) return msg;
    if (!_needsBudget(msg, config)) return msg;

    const outputsPath = _resolveOutputsPath(runtimeState ?? null);
    const sandbox = runtimeState ? _resolveSandbox(runtimeState) : null;

    return await _patchToolMessage(msg, config, outputsPath, await sandbox);
}

/**
 * 对历史消息列表应用输出预算。
 *
 * 在模型调用前调用（确保历史中的超大工具结果也被截断）。
 */
export function applyBudgetToHistory(
    messages: Array<Record<string, unknown>>,
    appConfig?: unknown,
): Array<Record<string, unknown>> {
    let config: ToolOutputConfig;
    try {
        const cfg = appConfig ?? getAppConfig();
        const toolOutput = (cfg as Record<string, unknown>).tool_output as ToolOutputConfig | undefined;
        config = toolOutput ?? _defaultConfig();
    } catch {
        config = _defaultConfig();
    }

    if (!config.enabled) return messages;

    const exemptTools = new Set(config.exempt_tools ?? []);
    const fallbackMax = config.fallback_max_chars ?? 20000;

    const updated = messages.map((msg) => {
        if (msg.type !== "tool") return msg;

        const toolName = (msg.name as string) ?? "";
        if (exemptTools.has(toolName)) return msg;

        const text = _messageText(msg.content);
        if (text === null || text.length <= fallbackMax) return msg;

        // 历史消息只做内联截断（不做磁盘持久化）
        return {
            ...msg,
            content: _buildFallback(text, {
                toolName,
                maxChars: fallbackMax,
                headChars: config.fallback_head_chars ?? 4000,
                tailChars: config.fallback_tail_chars ?? 1000,
            }),
        };
    });

    return updated;
}
