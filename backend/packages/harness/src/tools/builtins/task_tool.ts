/**
 * 任务委托工具 — 将子任务派发给专门的子代理。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/builtins/task_tool.py
 *
 * 流程：
 *   1. 获取子代理配置（registry）
 *   2. 检查 bash 子代理是否允许
 *   3. 合并父代理的 skills 白名单
 *   4. 获取可用工具（排除 task 工具防止嵌套）
 *   5. 创建 SubagentExecutor，启动后台执行
 *   6. 轮询结果，发送流式事件（task_started/task_running/task_completed）
 *   7. 上报 Token 用量
 *   8. 清理后台任务
 */

import { getAppConfig } from "../../config/app_config.js";
import { resolveRuntimeUserId } from "../../runtime/user_context.js";
import { isHostBashAllowed, LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE } from "../../sandbox/security.js";
import { type Runtime } from "../types.js";
import { getAvailableTools } from "../tools.js";
import { SubagentExecutor, SubagentStatus, createPendingResult, trySetTerminal, getBackgroundTaskResult, requestCancelBackgroundTask, cleanupBackgroundTask } from "../../subagents/executor.js";
import { getSubagentConfig, getAvailableSubagentNames } from "../../subagents/registry.js";
import { resolveSubagentModelName } from "../../subagents/config.js";
import { formatSubagentResultMessage, makeSubagentAdditionalKwargs } from "../../subagents/status_contract.js";
import { SubagentTokenCollector } from "../../subagents/token_collector.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 子代理 Token 用量缓存（tool_call_id → usage），供 TokenUsageMiddleware 使用 */
const _subagentUsageCache = new Map<string, Record<string, number>>();

export function popCachedSubagentUsage(toolCallId: string): Record<string, number> | undefined {
    const usage = _subagentUsageCache.get(toolCallId);
    _subagentUsageCache.delete(toolCallId);
    return usage;
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _summarizeUsage(records?: TokenUsageRecord[]): Record<string, number> | null {
    if (!records || records.length === 0) return null;
    return {
        input_tokens: records.reduce((s, r) => s + (r.input_tokens ?? 0), 0),
        output_tokens: records.reduce((s, r) => s + (r.output_tokens ?? 0), 0),
        total_tokens: records.reduce((s, r) => s + (r.total_tokens ?? 0), 0),
    };
}

function _mergeSkillAllowlists(parent: string[] | null, child: string[] | null): string[] | null {
    if (parent === null) return child;
    if (child === null) return [...parent];
    const parentSet = new Set(parent);
    return child.filter((s) => parentSet.has(s));
}

interface TokenUsageRecord {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    [key: string]: unknown;
}

// ════════════════════════════════════════════════════════════════════════════════
// 结果命令构建
// ════════════════════════════════════════════════════════════════════════════════

async function _taskResultCommand(options: {
    toolCallId: string;
    status: string;
    result?: string | null;
    error?: string | null;
    stopReason?: string | null;
    modelName?: string | null;
    usage?: Record<string, number> | null;
}): Promise<Record<string, unknown>> {
    const { toolCallId, status, result, error, stopReason, modelName, usage } = options;
    const [content] = formatSubagentResultMessage(status as never, { result, error, stop_reason: stopReason as never });
    const additionalKwargs = await makeSubagentAdditionalKwargs({
        status: status as never,
        results: result,
        error,
        stop_reason: stopReason as never,
        model_name: modelName,
        token_usage: (usage ?? null) as never,
    });

    return {
        type: "tool",
        content,
        tool_call_id: toolCallId,
        name: "task",
        additional_kwargs: additionalKwargs,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 委托任务给子代理。
 *
 * @param runtime 运行时
 * @param description 任务描述（3-5 字，用于日志）
 * @param prompt 子代理的任务说明
 * @param subagentType 子代理类型（general-purpose / bash / 自定义）
 * @param toolCallId 工具调用 ID
 * @returns 工具结果
 */
export async function taskTool(
    runtime: Runtime,
    _description: string,
    prompt: string,
    subagentType: string,
    toolCallId: string,
): Promise<Record<string, unknown>> {
    // 获取 AppConfig
    const runtimeAppConfig = (() => {
        const ctx = runtime.context;
        if (ctx?.app_config) return ctx.app_config as Record<string, unknown>;
        try { return getAppConfig() as Record<string, unknown>; } catch { return null; }
    })();

    const cacheTokenUsage = (() => {
        if (!runtimeAppConfig) return false;
        const tucfg = (runtimeAppConfig as Record<string, unknown>).token_usage as Record<string, unknown> | undefined;
        return tucfg?.enabled === true;
    })();

    // 获取子代理配置
    const config = runtimeAppConfig
        ? getSubagentConfig(subagentType, runtimeAppConfig)
        : getSubagentConfig(subagentType);

    if (!config) {
        const available = getAvailableSubagentNames(runtimeAppConfig ?? undefined).join(", ");
        return _taskResultCommand({
            toolCallId,
            status: "failed",
            error: `Unknown subagent type '${subagentType}'. Available: ${available}`,
        });
    }

    // bash 子代理检查
    if (subagentType === "bash") {
        const hostBashAllowed = runtimeAppConfig
            ? isHostBashAllowed(runtimeAppConfig)
            : isHostBashAllowed();
        if (!hostBashAllowed) {
            return _taskResultCommand({
                toolCallId,
                status: "failed",
                error: LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE,
            });
        }
    }

    // 从 runtime 提取上下文
    const sandboxState = runtime.state?.sandbox as Record<string, unknown> | undefined ?? null;
    const threadData = runtime.state?.thread_data as Record<string, unknown> | undefined ?? null;
    let threadId: string | undefined;
    if (runtime.context?.thread_id && typeof runtime.context.thread_id === "string") {
        threadId = runtime.context.thread_id;
    } else {
        const cfg = (runtime as Record<string, unknown>).config as Record<string, unknown> | undefined;
        const configurable = cfg?.configurable as Record<string, unknown> | undefined;
        if (configurable?.thread_id && typeof configurable.thread_id === "string") {
            threadId = configurable.thread_id;
        }
    }

    const metadata = ((runtime as Record<string, unknown>).config as Record<string, unknown> | undefined)
        ?.metadata as Record<string, unknown> | undefined ?? {};
    const parentModel = metadata.model_name as string | undefined;
    const traceId = (metadata.trace_id as string) ?? `tsk_${Date.now().toString(36)}`;

    const userId = resolveRuntimeUserId(runtime as unknown as Record<string, unknown>);
    const parentContext = (runtime.context ?? {}) as Record<string, unknown>;
    const userRole = parentContext.user_role as string | undefined;
    const oauthProvider = parentContext.oauth_provider as string | undefined;
    const oauthId = parentContext.oauth_id as string | undefined;
    const runId = parentContext.run_id as string | undefined;
    const channelUserId = parentContext.channel_user_id as string | undefined;

    const parentAvailableSkills = metadata.available_skills as string[] | undefined;
    let skillsOverride = config.skills;
    if (parentAvailableSkills) {
        skillsOverride = _mergeSkillAllowlists(parentAvailableSkills, config.skills);
    }

    // 合并覆盖
    const effectiveConfig = skillsOverride !== config.skills
        ? { ...config, skills: skillsOverride }
        : config;

    // 获取可用工具（排除 task 工具防止嵌套）
    const resolvedAppConfig = runtimeAppConfig;
    if (effectiveConfig.model === "inherit" && !parentModel && !resolvedAppConfig) {
        // 用默认配置
    }
    const effectiveModel = resolveSubagentModelName(effectiveConfig, parentModel, resolvedAppConfig as never);

    const tools = await getAvailableTools({
        modelName: effectiveModel,
        groups: metadata.tool_groups as string[] | undefined,
        subagentEnabled: false,
        appConfig: resolvedAppConfig ?? undefined,
    });

    // 创建执行器
    const executor = new SubagentExecutor({
        config: effectiveConfig,
        tools: tools as never[],
        appConfig: resolvedAppConfig ?? undefined,
        parentModel,
        threadId,
        traceId,
    });

    // 启动后台执行
    const taskId = executor.executeAsync(prompt, toolCallId);

    // ── 轮询结果 ──────────────────────────────────────────────

    const maxPollCount = Math.floor(((effectiveConfig.timeout_seconds ?? 900) + 60) / 5);
    let pollCount = 0;
    let lastStatus: string | undefined;
    let lastMessageCount = 0;

    // 发送 task_started 事件
    _emitStreamEvent({
        type: "task_started",
        task_id: taskId,
        description: _description,
        model_name: effectiveModel,
    });

    try {
        while (true) {
            const result = getBackgroundTaskResult(taskId);
            if (!result) {
                _emitStreamEvent({ type: "task_failed", task_id: taskId, error: "Task disappeared from background tasks" });
                cleanupBackgroundTask(taskId);
                return _taskResultCommand({ toolCallId, status: "failed", error: "Task disappeared from background tasks" });
            }

            if (result.status !== lastStatus) {
                lastStatus = result.status;
            }

            const usage = _summarizeUsage(result.token_usage_records as unknown as TokenUsageRecord[] | undefined);

            // 发送 task_running 事件
            const aiMessages = result.ai_messages ?? [];
            if (aiMessages.length > lastMessageCount) {
                for (let i = lastMessageCount; i < aiMessages.length; i++) {
                    _emitStreamEvent({
                        type: "task_running",
                        task_id: taskId,
                        message: aiMessages[i],
                        message_index: i + 1,
                        total_messages: aiMessages.length,
                        usage: usage ?? undefined,
                        model_name: effectiveModel,
                    });
                }
                lastMessageCount = aiMessages.length;
            }

            if (result.status === SubagentStatus.COMPLETED) {
                if (cacheTokenUsage && usage) _subagentUsageCache.set(toolCallId, usage);
                _emitStreamEvent({ type: "task_completed", task_id: taskId, result: result.result ?? undefined, usage: usage ?? undefined, model_name: effectiveModel });
                cleanupBackgroundTask(taskId);
                return _taskResultCommand({ toolCallId, status: "completed", result: result.result, stopReason: result.stop_reason, modelName: effectiveModel, usage });
            }

            if (result.status === SubagentStatus.FAILED) {
                if (cacheTokenUsage && usage) _subagentUsageCache.set(toolCallId, usage);
                _emitStreamEvent({ type: "task_failed", task_id: taskId, error: result.error ?? undefined, usage: usage ?? undefined, model_name: effectiveModel });
                cleanupBackgroundTask(taskId);
                return _taskResultCommand({ toolCallId, status: "failed", error: result.error, stopReason: result.stop_reason, modelName: effectiveModel, usage });
            }

            if (result.status === SubagentStatus.CANCELLED) {
                if (cacheTokenUsage && usage) _subagentUsageCache.set(toolCallId, usage);
                _emitStreamEvent({ type: "task_cancelled", task_id: taskId, error: result.error ?? undefined, usage: usage ?? undefined, model_name: effectiveModel });
                cleanupBackgroundTask(taskId);
                return _taskResultCommand({ toolCallId, status: "cancelled", error: result.error, modelName: effectiveModel, usage });
            }

            if (result.status === SubagentStatus.TIMED_OUT) {
                if (cacheTokenUsage && usage) _subagentUsageCache.set(toolCallId, usage);
                _emitStreamEvent({ type: "task_timed_out", task_id: taskId, error: result.error ?? undefined, usage: usage ?? undefined, model_name: effectiveModel });
                cleanupBackgroundTask(taskId);
                return _taskResultCommand({ toolCallId, status: "timed_out", error: result.error, modelName: effectiveModel, usage });
            }

            // 轮询超时
            await new Promise((resolve) => setTimeout(resolve, 5000));
            pollCount++;
            if (pollCount > maxPollCount) {
                requestCancelBackgroundTask(taskId);
                const status = result.status;
                _emitStreamEvent({ type: "task_timed_out", task_id: taskId, usage: usage ?? undefined, model_name: effectiveModel });
                cleanupBackgroundTask(taskId);
                return _taskResultCommand({
                    toolCallId,
                    status: "polling_timed_out",
                    error: `Task polling timed out after ${Math.floor(pollCount * 5 / 60)} minutes. Status: ${status}`,
                    modelName: effectiveModel,
                    usage,
                });
            }
        }
    } catch (error) {
        _subagentUsageCache.delete(toolCallId);
        throw error;
    }
}

function _emitStreamEvent(event: Record<string, unknown>): void {
    try {
        const writer = (globalThis as Record<string, unknown>).__stream_writer;
        if (typeof writer === "function") writer(event);
    } catch { /* 忽略 */ }
}
