/**
 * 记忆中间件 — Agent 执行后，将对话加入记忆更新队列。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py
 *
 * 流程：
 *   1. Agent 执行完后触发
 *   2. 过滤消息（只保留用户输入和 AI 回复，跳过工具结果）
 *   3. 检测是否有修正/强化信号
 *   4. 将过滤后的消息加入去抖队列
 *   5. 队列异步调 LLM 提取事实，存到 memory.json
 */

import { getAppConfig } from "../../config/app_config.js";
import { getMemoryQueue } from "../memory/queue.js";
import {
    filterMessagesForMemory,
    detectCorrection,
    detectReinforcement,
} from "../memory/message_processing.js";
import { getEffectiveUserId } from "../../runtime/user_context.js";
import { type MemoryConfig } from "../../config/memory_config.js";

const _DEERFLOW_TRACE_METADATA_KEY = "deerflow_trace_id";

function _normalizeTraceId(value: unknown): string | null {
    if (typeof value === "string" && value.trim()) return value.trim();
    return null;
}

function _getCurrentTraceId(): string | null {
    try {
        return (globalThis as Record<string, unknown>).__current_trace_id as string | null;
    } catch {
        return null;
    }
}

/**
 * 将对话加入记忆更新队列。
 *
 * 在 Agent 执行完成后调用。
 *
 * @param messages 消息列表
 * @param threadId 线程 ID
 * @param agentName Agent 名称
 * @param context 运行时上下文（用于提取 trace_id）
 */
export function queueMemoryUpdate(
    messages: Array<Record<string, unknown>>,
    threadId: string,
    agentName?: string | null,
    context?: Record<string, unknown> | null,
): void {
    const config = _resolveMemoryConfig();
    if (!config || !config.enabled) return;

    if (!messages || messages.length === 0) return;

    // 过滤消息（只保留用户和 AI 消息）
    const filteredMessages = filterMessagesForMemory(
        messages as Array<{ type?: string; content: unknown; additional_kwargs?: Record<string, unknown> }>,
    );

    // 至少需要一条用户消息和一条 AI 回复
    const userMessages = filteredMessages.filter((m) => m.type === "human");
    const aiMessages = filteredMessages.filter((m) => m.type === "ai");

    if (userMessages.length === 0 || aiMessages.length === 0) return;

    // 检测修正/强化信号
    const correctionDetected = detectCorrection(filteredMessages);
    const reinforcementDetected = !correctionDetected && detectReinforcement(filteredMessages);

    // 获取用户 ID
    const userId = getEffectiveUserId();

    // 解析 deerflow_trace_id（三级回退）
    let deerflowTraceId: string | null = null;
    // 第一级：runtime.context
    if (context) {
        deerflowTraceId = _normalizeTraceId(context[_DEERFLOW_TRACE_METADATA_KEY]);
    }
    // 第二级：全局配置（模拟原项目 get_config().metadata）
    if (!deerflowTraceId) {
        try {
            const cfg = getAppConfig() as Record<string, unknown>;
            deerflowTraceId = _normalizeTraceId((cfg.metadata as Record<string, unknown> | undefined)?.[_DEERFLOW_TRACE_METADATA_KEY]);
        } catch { /* ignore */ }
    }
    // 第三级：当前追踪 ID
    if (!deerflowTraceId) {
        deerflowTraceId = _getCurrentTraceId();
    }

    // 加入去抖队列
    const queue = getMemoryQueue();
    queue.add(
        threadId,
        filteredMessages as Array<{ type: string; content: unknown }>,
        agentName ?? undefined,
        userId,
        deerflowTraceId ?? undefined,
        correctionDetected,
        reinforcementDetected,
    );
}

function _resolveMemoryConfig(): MemoryConfig | null {
    try {
        const appConfig = getAppConfig() as Record<string, unknown>;
        return (appConfig.memory as MemoryConfig) ?? null;
    } catch {
        return null;
    }
}
