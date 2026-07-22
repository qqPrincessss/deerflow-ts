/**
 * 构建子代理步骤负载 — 用于流式传输和持久化。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/step_events.py
 *
 * Issue #3779: 子代理的执行步骤之前只能看到最新的一帧，刷新后就没了。
 * 这个模块把子代理的每一步（AI 回复、工具调用、工具结果）转成
 * 小的、可 JSON 序列化的 step 负载，既用来流式传输也用来持久化。
 *
 * 纯数据转换层，没有副作用，方便单元测试。
 */

import { type SubagentStatusValue } from "./status_contract.js";
import { normalizeTokenUsage } from "./status_contract.js";
import { messageContentToText } from "../utils/messages.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 每个 step 的 text 字段字符上限。工具输出可能很大，影响持久化和流式帧。 */
export const SUBAGENT_STEP_MAX_CHARS = 8192;

/** 持久化子代理 step 时用的 category。独立于 "message"，不混入消息列表。 */
export const SUBAGENT_EVENT_CATEGORY = "subagent";

/** task_* 终端事件类型 → 状态值映射 */
const _TERMINAL_EVENT_STATUS: Record<string, SubagentStatusValue> = {
    task_completed: "completed",
    task_failed: "failed",
    task_cancelled: "cancelled",
    task_timed_out: "timed_out",
};

// ════════════════════════════════════════════════════════════════════════════════
// 步骤捕获
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 将消息追加到 captured 列表（如果它是新步骤）。
 *
 * "步骤"是 AI 回复（assistant）或工具结果（tool）。
 * 其他消息类型（如 human）被忽略。
 * 去重：有 id 按 id，没有 id 按全量对比。
 *
 * @returns 是否追加了消息
 */
export function captureStepMessage(
    message: Record<string, unknown>,
    captured: Array<Record<string, unknown>>,
    seenIds: Set<string>,
): boolean {
    const type = message.type;
    if (type !== "ai" && type !== "tool") return false;

    const messageId = message.id;
    if (typeof messageId === "string" && messageId) {
        if (seenIds.has(messageId)) return false;
    } else {
        // 无 id 的消息：全量对比去重
        if (captured.some((m) => JSON.stringify(m) === JSON.stringify(message))) return false;
    }

    captured.push(message);
    if (typeof messageId === "string" && messageId) {
        seenIds.add(messageId);
    }
    return true;
}

/**
 * 捕获自 processedCount 以来新增的每一步消息（#3779）。
 *
 * 当消息列表增长时，遍历所有新增消息。
 * 当消息列表缩小时（压缩中间件重写 channel），重置游标到新尾部，
 * 让 captureStepMessage 的去重逻辑防止重新发射已捕获的步骤。
 *
 * @param messages 当前全部消息
 * @param captured 已捕获的消息列表（会被修改）
 * @param seenIds 已见过的消息 ID 集合（会被修改）
 * @param processedCount 上次处理到的位置
 * @returns 新的游标位置
 */
export function captureNewStepMessages(
    messages: Array<Record<string, unknown>>,
    captured: Array<Record<string, unknown>>,
    seenIds: Set<string>,
    processedCount: number,
): number {
    const total = messages.length;

    // 历史收缩（如压缩中间件删除了消息）
    if (total < processedCount) {
        processedCount = total;
    }

    // 历史增长：遍历新增消息
    if (total > processedCount) {
        for (let i = processedCount; i < total; i++) {
            captureStepMessage(messages[i], captured, seenIds);
        }
        return total;
    }

    // 历史未增长：只检查最后一条（可能被原地替换）
    if (messages.length > 0) {
        captureStepMessage(messages[messages.length - 1], captured, seenIds);
    }

    return Math.max(processedCount, total);
}

// ════════════════════════════════════════════════════════════════════════════════
// 文本截断
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 截断文本到 maxChars，返回 (text, truncated)。
 */
export function truncateStepText(text: string, maxChars: number): [string, boolean] {
    if (maxChars >= 0 && text.length > maxChars) {
        return [text.slice(0, maxChars), true];
    }
    return [text, false];
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具调用边界控制
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 返回 {name, args}，对大 args 做截断（#3779）。
 *
 * buildSubagentStep 截断 text 字段，但 tool_call args 原样复制。
 * 当 write_file/bash 携带大负载时，会导致持久化和流式帧无限增长。
 */
function _boundedToolCall(call: Record<string, unknown>, maxChars: number): Record<string, unknown> {
    const name = call.name;
    const args = call.args;
    const serialized = typeof args === "string" ? args : JSON.stringify(args);
    if (maxChars >= 0 && serialized.length > maxChars) {
        return { name, args: serialized.slice(0, maxChars), args_truncated: true };
    }
    return { name, args };
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建 step 负载
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从捕获的子代理消息字典构建紧凑的 step 负载。
 *
 * kind 为 "tool"（ToolMessage）或 "ai"（其他）。
 * AI step 携带 tool_calls（name + args，大 args 截断）。
 * tool step 携带 tool_name。
 * text 截断到 maxChars，truncated 标记是否截断。
 */
export function buildSubagentStep(
    message: Record<string, unknown>,
    options: {
        taskId: string;
        messageIndex: number;
        maxChars?: number;
    },
): Record<string, unknown> {
    const { taskId, messageIndex, maxChars = SUBAGENT_STEP_MAX_CHARS } = options;
    const kind = message.type === "tool" ? "tool" : "ai";

    // `... ?? ""` 防止纯工具调用的 content=None 渲染成 "None"
    const textContent = messageContentToText(message.content ?? "");
    const [text, truncated] = truncateStepText(textContent, maxChars);

    const step: Record<string, unknown> = {
        task_id: taskId,
        message_index: messageIndex,
        kind,
        text,
        truncated,
    };

    if (kind === "tool") {
        step.tool_name = message.name ?? null;
    } else {
        const toolCalls = (message.tool_calls as Array<Record<string, unknown>>) ?? [];
        step.tool_calls = toolCalls.map((call) => _boundedToolCall(call, maxChars));
    }

    return step;
}

// ════════════════════════════════════════════════════════════════════════════════
// 子代理运行事件映射
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 将 task_* 自定义流块映射为可持久化的事件数据。
 *
 * 返回 { event_type, category, content, metadata }，或 null（不是子代理事件）。
 *
 * 事件类型：
 * - task_started → subagent.start
 * - task_running → subagent.step（每一步）
 * - task_completed / task_failed / task_cancelled / task_timed_out → subagent.end
 */
export function subagentRunEvent(
    chunk: unknown,
): Record<string, unknown> | null {
    if (!chunk || typeof chunk !== "object") return null;

    const chunkObj = chunk as Record<string, unknown>;
    const event = chunkObj.type;
    if (typeof event !== "string" || !event.startsWith("task_")) return null;

    const taskId = chunkObj.task_id as string | undefined;

    if (event === "task_started") {
        return {
            event_type: "subagent.start",
            category: SUBAGENT_EVENT_CATEGORY,
            content: { task_id: taskId, description: chunkObj.description ?? null },
            metadata: { task_id: taskId },
        };
    }

    if (event === "task_running") {
        const messageIndex = chunkObj.message_index as number ?? 0;
        const message = (chunkObj.message ?? {}) as Record<string, unknown>;
        return {
            event_type: "subagent.step",
            category: SUBAGENT_EVENT_CATEGORY,
            content: buildSubagentStep(message, { taskId: taskId ?? "", messageIndex }),
            metadata: { task_id: taskId, message_index: messageIndex },
        };
    }

    const status = _TERMINAL_EVENT_STATUS[event];
    if (status !== undefined) {
        const content: Record<string, unknown> = {
            task_id: taskId,
            status,
        };

        const modelName = chunkObj.model_name;
        if (typeof modelName === "string" && modelName.trim()) {
            content.model_name = modelName.trim();
        }

        const usage = normalizeTokenUsage(chunkObj.usage);
        if (usage !== null) {
            content.usage = usage;
        }

        // 最终结果/错误可能很大，截断
        if (chunkObj.result != null) {
            const [result, resultTruncated] = truncateStepText(String(chunkObj.result), SUBAGENT_STEP_MAX_CHARS);
            content.result = result;
            if (resultTruncated) content.result_truncated = true;
        }
        if (chunkObj.error != null) {
            const [error, errorTruncated] = truncateStepText(String(chunkObj.error), SUBAGENT_STEP_MAX_CHARS);
            content.error = error;
            if (errorTruncated) content.error_truncated = true;
        }

        return {
            event_type: "subagent.end",
            category: SUBAGENT_EVENT_CATEGORY,
            content,
            metadata: { task_id: taskId },
        };
    }

    return null;
}
