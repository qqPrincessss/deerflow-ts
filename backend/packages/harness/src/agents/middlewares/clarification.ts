/**
 * 澄清中间件 — 拦截 ask_clarification 工具调用，中断执行并向用户展示问题。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/clarification_middleware.py
 *
 * 当 AI 调用 ask_clarification 时，不执行工具，而是：
 *   1. 格式化问题 + 选项
 *   2. 构建结构化 UI 负载
 *   3. 中断执行，等待用户回复
 *
 * 在非交互式渠道（如 GitHub webhook）中，澄清被禁用，
 * 中间件返回 ToolMessage 告诉 AI 用自己的判断继续。
 */

import { createHash } from "node:crypto";

// ════════════════════════════════════════════════════════════════════════════════
// 工具名
// ════════════════════════════════════════════════════════════════════════════════

const _ASK_CLARIFICATION_TOOL = "ask_clarification";

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _stableMessageId(toolCallId: string, formattedMessage: string): string {
    if (toolCallId) return `clarification:${toolCallId}`;
    const digest = createHash("sha256").update(formattedMessage).digest("hex").slice(0, 16);
    return `clarification:${digest}`;
}

function _normalizeOptions(rawOptions: unknown): string[] {
    if (rawOptions === null || rawOptions === undefined) return [];

    if (typeof rawOptions === "string") {
        try {
            const parsed = JSON.parse(rawOptions);
            if (Array.isArray(parsed)) return parsed.map(String);
            return [rawOptions];
        } catch {
            return [rawOptions];
        }
    }

    if (Array.isArray(rawOptions)) return rawOptions.map(String);
    return [String(rawOptions)];
}

function _buildHumanInputPayload(
    args: Record<string, unknown>,
    toolCallId: string,
    requestId: string,
): Record<string, unknown> {
    const options = _normalizeOptions(args.options);
    const clarificationType = String(args.clarification_type ?? "missing_info");

    const payload: Record<string, unknown> = {
        version: 1,
        kind: "human_input_request",
        source: "ask_clarification",
        request_id: requestId,
        clarification_type: clarificationType,
        question: String(args.question ?? ""),
        input_mode: options.length > 0 ? "choice_with_other" : "free_text",
    };

    if (toolCallId) payload.tool_call_id = toolCallId;

    if ("context" in args) {
        const ctx = args.context;
        payload.context = ctx === null ? null : String(ctx);
    }

    if (options.length > 0) {
        payload.options = options.map((opt, i) => ({
            id: `option-${i + 1}`,
            label: opt,
            value: opt,
        }));
    }

    return payload;
}

function _formatClarificationMessage(args: Record<string, unknown>): string {
    const question = String(args.question ?? "");
    const clarificationType = String(args.clarification_type ?? "missing_info");
    const context = args.context;
    const options = _normalizeOptions(args.options);

    const typeIcons: Record<string, string> = {
        missing_info: "❓",
        ambiguous_requirement: "🤔",
        approach_choice: "🔀",
        risk_confirmation: "⚠️",
        suggestion: "💡",
    };

    const icon = typeIcons[clarificationType] ?? "❓";
    const parts: string[] = [];

    if (context) {
        parts.push(`${icon} ${context}`);
        parts.push(`\n${question}`);
    } else {
        parts.push(`${icon} ${question}`);
    }

    if (options.length > 0) {
        parts.push("");
        for (let i = 0; i < options.length; i++) {
            parts.push(`  ${i + 1}. ${options[i]}`);
        }
    }

    return parts.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

export type ClarificationResult = {
    type: "interrupt";
    content: Record<string, unknown>;
} | {
    type: "disabled";
    content: Record<string, unknown>;
} | {
    type: "passthrough";
};

/**
 * 处理澄清工具调用。
 *
 * @param toolCall 工具调用
 * @param disableClarification 是否禁用澄清（非交互式渠道）
 * @returns 处理结果
 */
export function handleClarification(
    toolCall: Record<string, unknown> | undefined,
    disableClarification?: boolean,
): ClarificationResult {
    if (!toolCall || toolCall.name !== _ASK_CLARIFICATION_TOOL) {
        return { type: "passthrough" };
    }

    // 非交互式渠道：禁用澄清
    if (disableClarification) {
        const toolCallId = String(toolCall.id ?? "");
        return {
            type: "disabled",
            content: {
                type: "tool",
                id: _stableMessageId(toolCallId, "proceed-without-clarification"),
                content: [
                    "Clarification is disabled in this context — the human is not present ",
                    "to answer synchronously. Do not ask for confirmation. Proceed with your ",
                    "best judgment, carry out the requested action, and state any assumptions ",
                    "you made in your final response.",
                ].join(""),
                tool_call_id: toolCallId,
                name: "ask_clarification",
            },
        };
    }

    // 正常处理：中断执行
    const args = (toolCall.args as Record<string, unknown>) ?? {};
    const formattedMessage = _formatClarificationMessage(args);
    const toolCallId = String(toolCall.id ?? "");
    const requestId = _stableMessageId(toolCallId, formattedMessage);
    const humanInputPayload = _buildHumanInputPayload(args, toolCallId, requestId);

    return {
        type: "interrupt",
        content: {
            type: "tool",
            id: requestId,
            content: formattedMessage,
            tool_call_id: toolCallId,
            name: "ask_clarification",
            artifact: { human_input: humanInputPayload },
        },
    };
}
