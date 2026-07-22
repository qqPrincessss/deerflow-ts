/**
 * 工具总装 — 从配置加载并组装所有可用工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/tools.py
 *
 * 数据轮转：
 *   config.yaml 工具配置 + 内置工具 + MCP 工具 + ACP 工具
 *     → 按组过滤 → 按运行环境过滤 → 去重 → 返回给 Agent
 */

import { getAppConfig } from "../config/app_config.js";
import { resolveVariable } from "../reflection/resolvers.js";

// ════════════════════════════════════════════════════════════════════════════════
// 工具描述符
// ════════════════════════════════════════════════════════════════════════════════

export interface ToolDescriptor {
    name: string;
    use: string;
    group?: string;
    [key: string]: unknown;
}

export interface LoadedTool {
    name: string;
    description?: string;
    invoke: (...args: unknown[]) => Promise<unknown>;
    syncInvoke?: (...args: unknown[]) => unknown;
    group?: string;
    is_mcp?: boolean;
    is_acp?: boolean;
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

function _ensureSyncInvocable(tool: LoadedTool): LoadedTool {
    if (!tool.syncInvoke) {
        tool.syncInvoke = (...args: unknown[]) => {
            const result = tool.invoke(...args);
            if (result instanceof Promise) {
                return result;
            }
            return result;
        };
    }
    return tool;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 获取所有可用工具。
 */
export async function getAvailableTools(options?: {
    groups?: string[];
    includeMCP?: boolean;
    modelName?: string | null;
    subagentEnabled?: boolean;
    appConfig?: unknown;
}): Promise<LoadedTool[]> {
    const {
        groups,
        includeMCP = true,
        modelName,
        subagentEnabled = false,
        appConfig,
    } = options ?? {};

    const config = appConfig ?? getAppConfig();
    const configRecord = config as Record<string, unknown>;
    const toolConfigs = (configRecord.tools as ToolDescriptor[] | undefined) ?? [];

    // 按组过滤
    const filteredConfigs = groups
        ? toolConfigs.filter((t) => t.group && groups.includes(t.group))
        : toolConfigs;

    // ── 从配置加载工具 ─────────────────────────────────────────────

    const loadedTools: LoadedTool[] = [];
    for (const cfg of filteredConfigs) {
        try {
            const loaded = (await resolveVariable(cfg.use)) as LoadedTool | undefined;
            if (loaded) {
                loaded.group = cfg.group;
                loadedTools.push(loaded);
            }
        } catch {
            // 跳过加载失败的工具
        }
    }

    // ── 内置工具 ──────────────────────────────────────────────────

    const builtinTools: LoadedTool[] = [];

    // show files（展示文件工具）
    try {
        const { presentFileTool } = await import("./builtins/present_file_tool.js");
        builtinTools.push({
            name: "present_files",
            invoke: async (runtime: unknown, filepaths: unknown) => {
                return (presentFileTool as (r: unknown, f: unknown) => string)(runtime, filepaths);
            },
        });
    } catch { /* 跳过 */ }

    // ask clarification（澄清工具）
    try {
        const { askClarification } = await import("./builtins/clarification_tool.js");
        builtinTools.push({
            name: "ask_clarification",
            invoke: async (params: unknown) => {
                return (askClarification as (p: unknown) => string)(params);
            },
        });
    } catch { /* 跳过 */ }

    // task（子代理工具 — 仅当显式启用）
    if (subagentEnabled) {
        try {
            // TODO: 依赖 subagents/executor 完成后接入
            // const { taskTool } = await import("./builtins/task_tool.js");
        } catch { /* 跳过 */ }
    }

    // view_image（仅当模型支持 vision）
    let effectiveModelName = modelName;
    if (!effectiveModelName) {
        const models = configRecord.models as Array<Record<string, unknown>> | undefined;
        if (models && models.length > 0) {
            effectiveModelName = String(models[0].name);
        }
    }

    let supportsVision = false;
    if (effectiveModelName) {
        const getModelConfig = configRecord.get_model_config as
            | ((name: string) => Record<string, unknown> | undefined)
            | undefined;
        if (getModelConfig) {
            const modelCfg = getModelConfig(effectiveModelName);
            if (modelCfg?.supports_vision) supportsVision = true;
        }
    }

    if (supportsVision) {
        try {
            const { viewImageTool } = await import("./builtins/view_image_tool.js");
            builtinTools.push({
                name: "view_image",
                invoke: async (runtime: unknown, imagePath: unknown) => {
                    return (viewImageTool as (r: unknown, p: unknown) => string)(runtime, imagePath);
                },
            });
        } catch { /* 跳过 */ }
    }

    // ── MCP 工具 ──────────────────────────────────────────────────

    const mcpTools: LoadedTool[] = [];
    if (includeMCP) {
        try {
            // TODO: 接入 extensions_config + mcp/cache
        } catch {
            // MCP 模块不可用
        }
    }

    // ── ACP 工具 ──────────────────────────────────────────────────

    const acpTools: LoadedTool[] = [];
    try {
        // TODO: 接入 ACP agent
    } catch {
        // ACP 模块不可用
    }

    // ── 组装并去重 ────────────────────────────────────────────────

    const allTools = [...loadedTools, ...builtinTools, ...mcpTools, ...acpTools]
        .map((t) => _ensureSyncInvocable(t));

    const seenNames = new Set<string>();
    const uniqueTools: LoadedTool[] = [];

    for (const tool of allTools) {
        if (!seenNames.has(tool.name)) {
            uniqueTools.push(tool);
            seenNames.add(tool.name);
        } else {
            console.warn(
                `Duplicate tool name "${tool.name}" detected and skipped — ` +
                "check your config.yaml and MCP server registrations (issue #1803).",
            );
        }
    }

    return uniqueTools;
}
