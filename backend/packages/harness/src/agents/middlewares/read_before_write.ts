/**
 * 写前读门控 — 修改文件前必须读过当前版本（issue #3857）。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/read_before_write_middleware.py
 *
 * 问题：AI 经常"从不回读，只追加"，导致同一个报告被反复追加 5 遍。
 * 这个中间件强制：写文件之前必须读过当前版本。
 *
 * 设计：
 * - 无状态：读标记（sha256）存在 read_file 的 ToolMessage.additional_kwargs 上
 * - 写操作会使标记失效（文件内容变了，hash 对不上）
 * - 压缩删除读结果也会删除标记
 * - 文件不存在或无法读取时放行（fail-open）
 * - 按（scope, path）互斥锁，防止同轮多次写并发绕过门控
 * - 被阻断的写操作打上 deerflow_tool_meta 标记，供 ToolProgressMiddleware 识别
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 读标记存储在 additional_kwargs 中的 key */
const READ_MARK_KEY = "deerflow_read_mark";

/** 读文件的工具名 */
const _READ_TOOLS = new Set(["read_file"]);

/** 被门控的写工具名 */
const _GATED_WRITE_TOOLS = new Set(["write_file", "str_replace"]);

/** AIO/E2B 沙箱的错误前缀（读失败返回 "Error: ..." 字符串而非抛异常） */
const _UNINSPECTABLE_CONTENT_PREFIX = "Error:";

/** 阻断消息 */
const _BLOCK_MESSAGE =
    "Error: {tool_name} blocked — {path} already exists and you have not read its current version. " +
    "Any write invalidates earlier reads, so re-read before every modification. " +
    "Call read_file on it (a ranged read of the relevant section is enough, e.g. the last ~30 lines " +
    "before an append), check what is already there, then retry.";

// ════════════════════════════════════════════════════════════════════════════════
// 每路径互斥锁
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 按（scope, path）的互斥锁，串行化门控检查 + 工具执行。
 *
 * 问题：LangGraph 在同一轮中可能并发执行多个工具调用。
 * 如果两个 write_file 同时检查同一个过期的标记，可能都放行。
 * 这个锁确保对同一个文件的读写操作是串行的。
 *
 * 原项目使用 WeakValueDictionary 防止内存泄漏。
 * 这里用 Map，因为 TypeScript 没有 WeakValueDictionary。
 */
const _gateLocks = new Map<string, { lock: Promise<void>; unlock: () => void }>();
async function _withGateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // 获取或创建锁
    const existing = _gateLocks.get(key);
    if (existing) {
        await existing.lock;
    }

    let unlock: () => void;
    const lock = new Promise<void>((resolve) => {
        unlock = resolve;
    });

    _gateLocks.set(key, { lock: lock as Promise<void>, unlock: unlock! });

    try {
        return await fn();
    } finally {
        unlock!();
        _gateLocks.delete(key);
    }
}

function _gateLockKey(scope: string, normPath: string): string {
    return `${scope}:${normPath}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具调用结果标记
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 在被阻断的工具结果上打 deerflow_tool_meta 标记。
 *
 * ToolProgressMiddleware 通过这个标记识别被阻断的写操作，
 * 而不是把它当作正常执行的工具。
 */
function _normalizeToolResult(result: Record<string, unknown>): Record<string, unknown> {
    return {
        ...result,
        deerflow_tool_meta: {
            skipped: true,
        },
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _contentHash(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
}

function _normalizeMarkPath(path: string): string {
    return posix.normalize(path);
}

/** 工具调用中是否包含写操作 */
function _isWriteTool(toolCall: Record<string, unknown> | undefined): boolean {
    const name = toolCall?.name as string | undefined;
    return name !== undefined && _GATED_WRITE_TOOLS.has(name);
}

/** 工具调用中是否包含读操作 */
function _isReadTool(toolCall: Record<string, unknown> | undefined): boolean {
    const name = toolCall?.name as string | undefined;
    return name !== undefined && _READ_TOOLS.has(name);
}

/** 从工具调用中提取 path 参数 */
function _requestedPath(toolCall: Record<string, unknown> | undefined): string | null {
    if (!toolCall) return null;
    const args = toolCall.args as Record<string, unknown> | undefined;
    if (!args || typeof args !== "object") return null;
    const path = args.path;
    return typeof path === "string" && path ? path : null;
}

/**
 * 从消息列表中从后往前找最新的读标记 hash。
 */
function _latestMarkHash(
    messages: Array<Record<string, unknown>> | undefined | null,
    normPath: string,
): string | null {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type !== "tool") continue;
        const mark = (msg.additional_kwargs as Record<string, unknown> | undefined)?.[READ_MARK_KEY];
        if (mark && typeof mark === "object" && (mark as Record<string, unknown>).path === normPath) {
            const hash = (mark as Record<string, unknown>).hash;
            return typeof hash === "string" ? hash : null;
        }
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 获取门控锁的 scope（按 thread_id 或 sandbox_id 隔离）。
 */
export function gateLockScope(
    runtimeState: Record<string, unknown> | undefined | null,
): string {
    if (!runtimeState) return "global";
    const sandboxState = runtimeState.sandbox as Record<string, unknown> | undefined;
    if (sandboxState) {
        const sandboxId = sandboxState.sandbox_id;
        if (typeof sandboxId === "string" && sandboxId) return sandboxId;
    }
    return "global";
}

/**
 * 检查写操作是否被门控拦截（同步，带锁）。
 *
 * @param toolCall 工具调用（name, args, id）
 * @param messages 当前消息列表（用于查找读标记）
 * @param contentReader 读取文件当前内容的函数
 * @returns 如果被拦截返回错误消息 Record，否则返回 null
 */
export function checkWriteGate(
    toolCall: Record<string, unknown> | undefined,
    messages: Array<Record<string, unknown>> | undefined | null,
    contentReader: (path: string) => string,
): Record<string, unknown> | null {
    if (!_isWriteTool(toolCall)) return null;

    const path = _requestedPath(toolCall);
    if (!path) return null;

    try {
        const current = contentReader(path);

        // AIO/E2B 沙箱读失败返回 "Error: ..." 字符串
        if (current.startsWith(_UNINSPECTABLE_CONTENT_PREFIX)) {
            return null; // fail-open
        }

        const normPath = _normalizeMarkPath(path);
        const latestHash = _latestMarkHash(messages, normPath);

        if (latestHash === _contentHash(current)) {
            return null; // 标记匹配，放行
        }

        // 标记不匹配（没读过、或文件内容已变化）
        const toolName = String(toolCall?.name ?? "write");
        const blocked = {
            type: "tool" as const,
            content: _BLOCK_MESSAGE.replace("{tool_name}", toolName).replace("{path}", path),
            tool_call_id: String(toolCall?.id ?? ""),
            name: toolName,
            status: "error" as const,
        };
        return _normalizeToolResult(blocked);
    } catch {
        // 文件不存在（create）或无法读取 → fail-open
        return null;
    }
}

/**
 * 检查写操作是否被门控拦截（异步，带锁）。
 */
export async function acheckWriteGate(
    toolCall: Record<string, unknown> | undefined,
    messages: Array<Record<string, unknown>> | undefined | null,
    contentReader: (path: string) => string,
    scope: string,
): Promise<Record<string, unknown> | null> {
    if (!_isWriteTool(toolCall)) return null;

    const path = _requestedPath(toolCall);
    if (!path) return null;

    const normPath = _normalizeMarkPath(path);
    const lockKey = _gateLockKey(scope, normPath);

    return _withGateLock(lockKey, async () => {
        return checkWriteGate(toolCall, messages, contentReader);
    });
}

/**
 * 在读操作结果上附加读标记（同步）。
 */
export function attachReadMark(
    toolCall: Record<string, unknown> | undefined,
    toolResult: Record<string, unknown>,
    contentReader: (path: string) => string,
): void {
    if (!_isReadTool(toolCall)) return;
    if (toolResult.status === "error") return;

    const path = _requestedPath(toolCall);
    if (!path) return;

    try {
        const content = contentReader(path);
        if (content.startsWith(_UNINSPECTABLE_CONTENT_PREFIX)) return;

        const additionalKwargs = (toolResult.additional_kwargs as Record<string, unknown>) ?? {};
        additionalKwargs[READ_MARK_KEY] = {
            path: _normalizeMarkPath(path),
            hash: _contentHash(content),
        };
        toolResult.additional_kwargs = additionalKwargs;
    } catch {
        // 文件不可哈希（二进制等）→ 跳过标记
    }
}

/**
 * 在读操作结果上附加读标记（异步，带锁）。
 */
export async function aattachReadMark(
    toolCall: Record<string, unknown> | undefined,
    toolResult: Record<string, unknown>,
    contentReader: (path: string) => string,
    scope: string,
): Promise<void> {
    if (!_isReadTool(toolCall)) return;

    const path = _requestedPath(toolCall);
    if (!path) return;

    const normPath = _normalizeMarkPath(path);
    const lockKey = _gateLockKey(scope, normPath);

    return _withGateLock(lockKey, async () => {
        attachReadMark(toolCall, toolResult, contentReader);
    });
}
