/**
 * 子代理限制中间件 — 限制单次模型响应和整个 run 中的子代理数量。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/subagent_limit_middleware.py
 *
 * 两重限制：
 *   1. 每次 AI 回复中最多 max_concurrent 个 task 调用（默认 3，范围 [2,4]）
 *   2. 每个 run 中最多 max_total 个 task 调用（默认 6，范围 [1,50]）
 *
 * 超出的 task 调用被丢弃，AI 收到提示消息。
 */

import {
    clampSubagentConcurrency,
    clampTotalSubagentsPerRun,
    DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN,
} from "../../config/subagents_config.js";
import { cloneAiMessageWithToolCalls } from "./tool_call_metadata.js";

const MAX_CONCURRENT_SUBAGENTS = 3;

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _TOTAL_LIMIT_STOP_MSG = (
    "[SUBAGENT LIMIT REACHED] The subagent delegation limit for this run has been reached. " +
    "Continue using the subagent results already collected, execute remaining simple work " +
    "directly, or summarize the remaining work instead of launching more subagents."
);

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _appendText(content: unknown, text: string): unknown {
    if (content === null || content === undefined) return text;
    if (typeof content === "string") return content ? `${content}\n\n${text}` : text;
    if (Array.isArray(content)) return [...content, { type: "text", text: `\n\n${text}` }];
    return `${String(content)}\n\n${text}`;
}

function _delegationId(entry: unknown): string | null {
    if (typeof entry !== "object" || entry === null) return null;
    const id = (entry as Record<string, unknown>).id;
    return typeof id === "string" ? id : null;
}

function _delegationRunId(entry: unknown): string | null {
    if (typeof entry !== "object" || entry === null) return null;
    const runId = (entry as Record<string, unknown>).run_id;
    return typeof runId === "string" ? runId : null;
}

function _countPriorDelegations(delegations: unknown, runId: string | null): number {
    if (!Array.isArray(delegations)) return 0;
    const ids = new Set<string>();
    for (const entry of delegations) {
        if (runId !== null && _delegationRunId(entry) !== runId) continue;
        const id = _delegationId(entry);
        if (id) ids.add(id);
    }
    return ids.size;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

function _runtimeRunId(context?: Record<string, unknown> | null): string | null {
    if (!context) return null;
    const runId = context.run_id;
    return typeof runId === "string" ? runId : null;
}

/**
 * 截断超出限制的 task 工具调用。
 *
 * @param messages 当前消息列表
 * @param delegations 委托账本
 * @param context 运行时上下文（用于提取 run_id）
 * @param maxConcurrent 并发限制
 * @param maxTotal 总限制
 * @returns state 更新或 null
 */
export function truncateTaskCalls(
    messages: Array<Record<string, unknown>>,
    delegations?: Array<Record<string, unknown>> | null,
    context?: Record<string, unknown> | null,
    maxConcurrent?: number,
    maxTotal?: number,
): Record<string, unknown> | null {
    const concurrent = clampSubagentConcurrency(maxConcurrent ?? MAX_CONCURRENT_SUBAGENTS);
    const total = clampTotalSubagentsPerRun(maxTotal ?? DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN);

    if (!messages || messages.length === 0) return null;

    const lastMsg = messages[messages.length - 1];
    if (lastMsg.type !== "ai") return null;

    const toolCalls = lastMsg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!toolCalls || toolCalls.length === 0) return null;

    // 找出所有 task 调用
    const taskIndices: number[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
        if (toolCalls[i].name === "task") taskIndices.push(i);
    }
    if (taskIndices.length === 0) return null;

    // 从 context 解析 run_id
    const runId = _runtimeRunId(context ?? null);

    // 计算剩余额度
    const priorCount = _countPriorDelegations(delegations, runId);
    const remainingTotal = Math.max(0, total - priorCount);
    const allowedCount = Math.min(concurrent, remainingTotal);

    if (taskIndices.length <= allowedCount) return null;

    // 截断超出的 task 调用
    const indicesToDrop = new Set(taskIndices.slice(allowedCount));
    const truncatedToolCalls = toolCalls.filter((_, i) => !indicesToDrop.has(i));
    const droppedCount = indicesToDrop.size;

    // 如果剩余额度为 0，在消息末尾加上提示
    const content = remainingTotal === 0 ? _appendText(lastMsg.content, _TOTAL_LIMIT_STOP_MSG) : undefined;

    // 使用 cloneAiMessageWithToolCalls 克隆消息（保留 id 供 reducer 替换）
    const updatedMsg = cloneAiMessageWithToolCalls(lastMsg, truncatedToolCalls, content);

    return { messages: [updatedMsg] };
}

/**
 * 模型调用后处理（同步）。
 * 从 state 中读取消息和委托账本，截断超出的 task 调用。
 */
export function afterModelSubagentLimit(
    state: Record<string, unknown>,
    context?: Record<string, unknown> | null,
): Record<string, unknown> | null {
    const messages = state.messages as Array<Record<string, unknown>> | undefined;
    const delegations = state.delegations as Array<Record<string, unknown>> | undefined;
    return truncateTaskCalls(messages ?? [], delegations ?? null, context);
}

/**
 * 模型调用后处理（异步）。
 */
export async function aafterModelSubagentLimit(
    state: Record<string, unknown>,
    context?: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
    return afterModelSubagentLimit(state, context);
}
