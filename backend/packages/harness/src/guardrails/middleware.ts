/**
 * 安全防护中间件 — 执行前评估工具调用。
 *
 * 对应原项目：backend/packages/harness/deerflow/guardrails/middleware.py
 *
 * 在工具执行前调用 GuardrailProvider 评估是否允许。
 * 拒绝的调用返回错误 ToolMessage，让 Agent 可以调整策略。
 * 如果提供者报错，取决于 fail_closed 配置：
 *   true（默认）：阻断调用
 *   false：放行，记录警告
 */

import { type GuardrailRequest, type GuardrailDecision, type GuardrailReason } from "./types.js";
import { type GuardrailProvider } from "./provider.js";

const _REASON_MESSAGE_LIMIT = 500;

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _buildRequest(
    toolCall: Record<string, unknown> | undefined,
    context: Record<string, unknown> | undefined,
    passport?: string | null,
): GuardrailRequest {
    return {
        tool_name: String(toolCall?.name ?? ""),
        tool_input: (toolCall?.args as Record<string, unknown>) ?? {},
        agent_id: passport ?? null,
        thread_id: (context?.thread_id as string) ?? null,
        is_subagent: Boolean(context?.is_subagent),
        timestamp: new Date().toISOString(),
        user_id: (context?.user_id as string) ?? null,
        user_role: (context?.user_role as string) ?? null,
        oauth_provider: (context?.oauth_provider as string) ?? null,
        oauth_id: (context?.oauth_id as string) ?? null,
        run_id: (context?.run_id as string) ?? null,
        tool_call_id: (toolCall?.id as string) ?? null,
    };
}

function _buildDeniedMessage(
    toolCall: Record<string, unknown> | undefined,
    decision: GuardrailDecision,
): Record<string, unknown> {
    const toolName = String(toolCall?.name ?? "unknown_tool");
    const toolCallId = String(toolCall?.id ?? "missing_id");
    const reasonText = decision.reasons?.[0]?.message ?? "blocked by guardrail policy";
    const reasonCode = decision.reasons?.[0]?.code ?? "oap.denied";

    return {
        type: "tool",
        content: `Guardrail denied: tool '${toolName}' was blocked (${reasonCode}). Reason: ${reasonText}. Choose an alternative approach.`,
        tool_call_id: toolCallId,
        name: toolName,
        status: "error",
    };
}

/**
 * 评估工具调用（同步）。
 *
 * @param toolCall 工具调用信息（name, args, id）
 * @param provider GuardrailProvider 实例
 * @param context 运行时上下文
 * @param options.failClosed 提供者报错时是否阻断（默认 true）
 * @param options.passport Agent 身份标识
 * @returns 工具结果消息（放行则返回 null）
 */
export function evaluateToolCall(
    toolCall: Record<string, unknown> | undefined,
    provider: GuardrailProvider,
    context?: Record<string, unknown> | null,
    options?: {
        failClosed?: boolean;
        passport?: string | null;
    },
): Record<string, unknown> | null {
    const { failClosed = true, passport } = options ?? {};
    const gr = _buildRequest(toolCall, context ?? undefined, passport);

    try {
        const decision = provider.evaluate(gr);
        if (!decision.allow) {
            return _buildDeniedMessage(toolCall, decision);
        }
        return null; // 放行
    } catch (error) {
        if (failClosed) {
            const decision: GuardrailDecision = {
                allow: false,
                reasons: [{ code: "oap.evaluator_error", message: "guardrail provider error (fail-closed)" }],
            };
            return _buildDeniedMessage(toolCall, decision);
        }
        return null; // fail-open：放行
    }
}

/**
 * 评估工具调用（异步）。
 */
export async function aevaluateToolCall(
    toolCall: Record<string, unknown> | undefined,
    provider: GuardrailProvider,
    context?: Record<string, unknown> | null,
    options?: {
        failClosed?: boolean;
        passport?: string | null;
    },
): Promise<Record<string, unknown> | null> {
    const { failClosed = true, passport } = options ?? {};
    const gr = _buildRequest(toolCall, context ?? undefined, passport);

    try {
        const decision = await provider.aevaluate(gr);
        if (!decision.allow) {
            return _buildDeniedMessage(toolCall, decision);
        }
        return null;
    } catch (error) {
        if (failClosed) {
            const decision: GuardrailDecision = {
                allow: false,
                reasons: [{ code: "oap.evaluator_error", message: "guardrail provider error (fail-closed)" }],
            };
            return _buildDeniedMessage(toolCall, decision);
        }
        return null;
    }
}
