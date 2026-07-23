/**
 * 安全终止原因中间件 — 当 LLM 因安全原因终止响应时，清除工具调用。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/safety_finish_reason_middleware.py
 *
 * 有些提供商（OpenAI finish_reason=content_filter、Anthropic stop_reason=refusal、
 * Gemini finish_reason=SAFETY）会在返回不完整 tool_calls 的同时终止生成。
 * LangChain 仍然会执行这些半截的工具调用，导致 AI 看到截断的结果，尝试修复，又被过滤，死循环。
 *
 * 这个中间件检测到安全终止信号后，清除 tool_calls，追加解释消息。
 */

import { type SafetyTermination, type SafetyTerminationDetector, defaultDetectors } from "./safety_termination_detectors.js";
import { cloneAiMessageWithToolCalls } from "./tool_call_metadata.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _USER_FACING_MESSAGE =
    "The model provider stopped this response with a safety-related signal " +
    "({reason_field}={reason_value!r}, detector={detector!r}). Any tool " +
    "calls produced in this turn were suppressed because their arguments " +
    "may be truncated and unsafe to execute. Please rephrase the request " +
    "or ask for a narrower output.";

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _appendUserMessage(content: unknown, text: string): unknown {
    if (content === null || content === "") return text;
    if (Array.isArray(content)) return [...content, { type: "text", text: `\n\n${text}` }];
    if (typeof content === "string") return content + `\n\n${text}`;
    return String(content) + `\n\n${text}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 发射 safety_termination 事件到流写入器（前端 SSE 使用）。
 */
function _emitEvent(
    termination: SafetyTermination,
    suppressedNames: string[],
    threadId?: string | null,
): void {
    try {
        const globalWriter = (globalThis as Record<string, unknown>).__stream_writer;
        if (typeof globalWriter === "function") {
            globalWriter({
                type: "safety_termination",
                detector: termination.detector,
                reason_field: termination.reason_field,
                reason_value: termination.reason_value,
                suppressed_tool_call_count: suppressedNames.length,
                suppressed_tool_call_names: suppressedNames,
                thread_id: threadId,
            });
        }
    } catch {
        // 发射失败不影响主流程
    }
}

/**
 * 检测并处理安全终止信号。
 *
 * @param messages 消息列表
 * @param detectors 检测器列表
 * @param threadId 线程 ID（用于事件发射）
 * @returns state 更新或 null
 */
export function applySafetyFinishReason(
    messages: Array<Record<string, unknown>>,
    detectors?: SafetyTerminationDetector[],
    threadId?: string | null,
): Record<string, unknown> | null {
    if (!messages || messages.length === 0) return null;

    const last = messages[messages.length - 1];
    if (last.type !== "ai") return null;

    const toolCalls = last.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!toolCalls || toolCalls.length === 0) return null;

    const dets = detectors ?? defaultDetectors();

    // 逐个检测器检查
    let termination: ReturnType<SafetyTerminationDetector["detect"]> = null;
    for (const detector of dets) {
        try {
            termination = detector.detect(last);
            if (termination) break;
        } catch {
            continue;
        }
    }

    if (!termination) return null;

    // 构建抑制消息
    const suppressedNames = toolCalls.map((tc) => String(tc.name ?? "unknown"));
    const explanation = _USER_FACING_MESSAGE
        .replace("{reason_field}", termination.reason_field)
        .replace("{reason_value}", termination.reason_value)
        .replace("{detector}", termination.detector);

    const newContent = _appendUserMessage(last.content, explanation);
    const cleared = cloneAiMessageWithToolCalls(last, [], newContent);

    // 打观察标记
    const kwargs = { ...((cleared.additional_kwargs as Record<string, unknown>) ?? {}) };
    kwargs.safety_termination = {
        detector: termination.detector,
        reason_field: termination.reason_field,
        reason_value: termination.reason_value,
        suppressed_tool_call_count: suppressedNames.length,
        suppressed_tool_call_names: suppressedNames,
        extras: termination.extras ?? {},
    };

    // 发射 SSE 事件
    _emitEvent(termination, suppressedNames, threadId);

    return {
        messages: [{ ...cleared, additional_kwargs: kwargs }],
    };
}
