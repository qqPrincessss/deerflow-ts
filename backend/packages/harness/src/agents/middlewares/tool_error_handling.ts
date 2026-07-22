/**
 * 工具错误处理中间件 — 将工具异常转为错误消息，让 Agent 继续运行。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py
 *
 * 没有这个中间件：工具抛异常 → 整个 run 崩了 → 用户看到 500
 * 有这个中间件：工具抛异常 → 捕获 → 转成 ToolMessage → Agent 看到错误信息，调整策略重试
 *
 * 附加功能：读技能文件时自动注入技能上下文元数据。
 */

import { normalizeToolResult, stampExceptionMeta } from "./tool_result_meta.js";
import { type AppConfig } from "../../config/app_config.js";
import { DEFAULT_SKILLS_CONTAINER_PATH } from "../../constants.js";
import { SKILL_CONTEXT_ENTRY_KEY, buildSkillEntryMetadataFromRead, toolCallPath } from "./skill_context.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _RECOVERY_HINT = "Continue with available context, or choose an alternative tool.";
const _MISSING_TOOL_CALL_ID = "missing_tool_call_id";
const _TASK_TOOL_NAME = "task";
const _DEFAULT_SKILL_FILE_READ_TOOL_NAMES = new Set(["read_file", "skill_read"]);

// ════════════════════════════════════════════════════════════════════════════════
// 技能读取元数据标记
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 在技能文件读取结果上打技能上下文标记。
 *
 * 当工具是 read_file 且读取的路径在技能目录下时，
 * 提取技能元数据（路径、描述）存到 additional_kwargs 中，
 * 供 SkillContextMiddleware 读取和使用。
 */
function _stampSkillReadMetadata(
    toolName: string,
    toolResult: Record<string, unknown>,
    toolCall: Record<string, unknown> | undefined,
    skillReadToolNames: Set<string>,
    skillsRoot: string,
): Record<string, unknown> {
    // 只处理技能读取工具
    if (!skillReadToolNames.has(toolName)) return toolResult;
    // 只处理成功的工具结果
    if (toolResult.status === "error") return toolResult;
    // 只处理字符串内容
    const content = typeof toolResult.content === "string" ? toolResult.content : null;
    if (content === null) return toolResult;

    // 从工具调用中提取路径
    const path = toolCallPath(toolCall ?? {});
    if (path === null) return toolResult;

    // 构建技能条目元数据
    const entry = buildSkillEntryMetadataFromRead(path, content, skillsRoot);
    if (entry === null) return toolResult;

    // 注入到 additional_kwargs
    const additionalKwargs = { ...((toolResult.additional_kwargs as Record<string, unknown>) ?? {}) };
    additionalKwargs[SKILL_CONTEXT_ENTRY_KEY] = { ...entry };
    return { ...toolResult, additional_kwargs: additionalKwargs };
}

/**
 * 对工具结果应用生产方元数据。
 */
function _maybeStamp(
    result: Record<string, unknown>,
    toolCall: Record<string, unknown> | undefined,
    skillReadToolNames: Set<string>,
    skillsRoot: string,
): Record<string, unknown> {
    const toolName = String(toolCall?.name ?? "");
    return _stampSkillReadMetadata(toolName, result, toolCall, skillReadToolNames, skillsRoot);
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建错误消息
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 构建工具错误消息。
 */
export function buildToolErrorMessage(
    toolCall: Record<string, unknown> | undefined,
    exc: Error,
    _appConfig?: AppConfig,
): Record<string, unknown> {
    const toolName = String(toolCall?.name ?? "unknown_tool");
    const toolCallId = String(toolCall?.id ?? _MISSING_TOOL_CALL_ID);

    let detail = (exc.message ?? "").trim();
    if (!detail) detail = exc.constructor.name;
    if (detail.length > 500) detail = detail.slice(0, 497) + "...";

    const content = `Error: Tool '${toolName}' failed with ${exc.constructor.name}: ${detail}. ${_RECOVERY_HINT}`;

    const message: Record<string, unknown> = {
        type: "tool",
        content,
        tool_call_id: toolCallId,
        name: toolName,
        status: "error",
        additional_kwargs: {},
    };

    // 给 task 工具打上子代理状态
    if (toolName === _TASK_TOOL_NAME) {
        const errorText = `${exc.constructor.name}: ${detail}`;
        let errContent = errorText;
        if (!errContent.endsWith(".") && !errContent.endsWith("!") && !errContent.endsWith("?")) {
            errContent += ".";
        }
        message.content = `${errContent} ${_RECOVERY_HINT}`;
        message.additional_kwargs = {
            subagent_status: "failed",
            subagent_error: errorText,
        };
    }

    // 打 deerflow_tool_meta 标签
    stampExceptionMeta(message, `${exc.constructor.name}: ${detail}`);

    return message;
}

/**
 * 解析技能配置。
 */
function _resolveSkillConfig(appConfig?: AppConfig): {
    skillReadToolNames: Set<string>;
    skillsRoot: string;
} {
    if (!appConfig) {
        return {
            skillReadToolNames: _DEFAULT_SKILL_FILE_READ_TOOL_NAMES,
            skillsRoot: DEFAULT_SKILLS_CONTAINER_PATH,
        };
    }
    const config = appConfig as Record<string, unknown>;
    const summarization = config.summarization as Record<string, unknown> | undefined;
    const skillFileReadToolNames = summarization?.skill_file_read_tool_names as string[] | undefined;
    const skills = config.skills as Record<string, unknown> | undefined;
    return {
        skillReadToolNames: skillFileReadToolNames
            ? new Set(skillFileReadToolNames)
            : _DEFAULT_SKILL_FILE_READ_TOOL_NAMES,
        skillsRoot: (skills?.container_path as string) ?? DEFAULT_SKILLS_CONTAINER_PATH,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 包装工具调用，捕获异常转为错误消息。
 *
 * 在工具执行外层调用。
 */
export function wrapToolCallWithErrorHandling(
    toolCall: Record<string, unknown> | undefined,
    handler: () => Record<string, unknown>,
    appConfig?: AppConfig,
): Record<string, unknown> {
    try {
        const result = handler();
        const config = _resolveSkillConfig(appConfig);
        const stamped = _maybeStamp(result, toolCall, config.skillReadToolNames, config.skillsRoot);
        normalizeToolResult(stamped);
        return stamped;
    } catch (error) {
        return buildToolErrorMessage(toolCall, error as Error, appConfig);
    }
}

/**
 * 包装异步工具调用，捕获异常转为错误消息。
 */
export async function awrapToolCallWithErrorHandling(
    toolCall: Record<string, unknown> | undefined,
    handler: () => Promise<Record<string, unknown>>,
    appConfig?: AppConfig,
): Promise<Record<string, unknown>> {
    try {
        const result = await handler();
        const config = _resolveSkillConfig(appConfig);
        const stamped = _maybeStamp(result, toolCall, config.skillReadToolNames, config.skillsRoot);
        normalizeToolResult(stamped);
        return stamped;
    } catch (error) {
        return buildToolErrorMessage(toolCall, error as Error, appConfig);
    }
}
