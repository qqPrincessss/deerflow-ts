/**
 * 委托账本 — 记录子代理委托状态。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/delegation_ledger.py
 *
 * 场景：主代理派了子代理去做任务。这个模块记录"派了哪些子代理、它们的状态是什么"。
 * 下次调用 LLM 时，告诉它"你已经派了这些任务，不要重复派"。
 */

import { type DelegationEntry } from "../thread_state.js";
import { readSubagentResultMetadata } from "../../subagents/status_contract.js";

// ─── 常量 ──────────────────────────────────────────────────

/** 结果摘要最大字符数 */
const RESULT_BRIEF_CAP = 2000;

/** 描述最大字符数 */
const DESCRIPTION_CAP = 200;

/** 渲染预算最大字符数 */
const LEDGER_RENDER_CHAR_BUDGET = 6000;

/** 渲染时每个条目的结果最大字符数 */
const LEDGER_ENTRY_RESULT_RENDER_CAP = 120;

/** 只有状态的结果摘要 */
const STATUS_ONLY_RESULT_BRIEFS: Record<string, string> = {
    failed: "Task failed.",
    cancelled: "Task cancelled by user.",
    timed_out: "Task timed out.",
    polling_timed_out: "Task polling timed out.",
};

// ─── 工具函数 ──────────────────────────────────────────────────

/**
 * 获取当前 UTC 时间的 ISO 字符串。
 */
function utcNowIso(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 截断文本（头尾保留）。
 */
function boundText(text: string, cap: number = RESULT_BRIEF_CAP): string {
    if (text.length <= cap) return text;
    if (cap <= 0) return "";
    const head = Math.floor(cap * 2 / 3);
    const marker = "\n...\n";
    if (cap <= marker.length) return text.slice(0, cap);
    const tail = cap - head - marker.length;
    if (tail <= 0) return text.slice(0, cap);
    return text.slice(0, head) + marker + text.slice(-tail);
}

/**
 * HTML 转义。
 */
function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * 根据状态生成指导文本。
 *
 * 告诉 LLM 这个委托的结果应该怎么处理：
 * - completed: 复用结果，不要重复委托
 * - failed: 可以重试
 * - in_progress: 等待结果，不要重复委托
 */
function statusGuidance(status: string, stopReason?: string): string {
    if (stopReason) {
        if (status === "completed") {
            return "hit a guardrail cap with a partial result; reuse the partial result, retry with a tighter scope, or raise the per-agent budget (max_turns / token_budget)";
        }
        return "hit a guardrail cap with no usable result; retry with a tighter scope or raise the per-agent budget (max_turns / token_budget)";
    }
    switch (status) {
        case "in_progress":
            return "already delegated; do NOT delegate again; wait for or build on the result";
        case "completed":
            return "completed result; do NOT delegate again; reuse this result";
        case "failed":
            return "failed attempt; may retry with a changed plan";
        case "cancelled":
            return "cancelled attempt; may retry with a changed plan";
        case "timed_out":
            return "timed-out attempt; may retry with a changed plan";
        case "polling_timed_out":
            return "polling timed-out attempt; may retry with a changed plan";
        default:
            return "prior attempt; inspect status before retrying";
    }
}

/**
 * 从 tool_call 中提取工具名。
 */
function toolCallName(toolCall: Record<string, unknown>): string {
    const name = toolCall.name;
    if (typeof name === "string") return name;
    const func = toolCall.function;
    if (func && typeof func === "object" && typeof (func as Record<string, unknown>).name === "string") {
        return (func as Record<string, unknown>).name as string;
    }
    return "";
}

/**
 * 从 tool_call 中提取 ID。
 */
function toolCallId(toolCall: Record<string, unknown>): string | null {
    const id = toolCall.id;
    return id ? String(id) : null;
}

/**
 * 从 tool_call 中提取参数。
 */
function toolCallArgs(toolCall: Record<string, unknown>): Record<string, unknown> {
    const args = toolCall.args;
    return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 从消息历史中提取子代理委托。
 *
 * 对应原项目 extract_delegations。
 *
 * 流程：
 * 1. 第一遍找 AIMessage 的 task tool_call → 记录委托
 * 2. 第二遍找 ToolMessage 的结果 → 更新委托状态
 */
export function extractDelegations(messages: Array<Record<string, unknown>>): DelegationEntry[] {
    const entriesById = new Map<string, DelegationEntry>();
    const order: string[] = [];
    const now = utcNowIso();

    // 第一遍：找 task tool_call
    for (const message of messages) {
        if (message.constructor?.name !== "AIMessage") continue;
        const toolCalls = (message.tool_calls as Array<Record<string, unknown>>) || [];
        for (const toolCall of toolCalls) {
            if (toolCallName(toolCall) !== "task") continue;
            const id = toolCallId(toolCall);
            if (!id) continue;
            const args = toolCallArgs(toolCall);
            const description = String(args.description || args.prompt || "").slice(0, DESCRIPTION_CAP);
            if (!entriesById.has(id)) {
                order.push(id);
            }
            entriesById.set(id, {
                id,
                description,
                subagent_type: String(args.subagent_type || ""),
                status: "in_progress",
                created_at: now,
            });
        }
    }

    // 第二遍：找 ToolMessage 结果
    for (const message of messages) {
        if (message.constructor?.name !== "ToolMessage") continue;
        const toolCallIdStr = message.tool_call_id ? String(message.tool_call_id) : "";
        const entry = entriesById.get(toolCallIdStr);
        if (!entry) continue;

        const structured = readSubagentResultMetadata(
            message.additional_kwargs as Record<string, unknown>
        );
        if (!structured) continue;

        entry.status = structured.status;
        if (structured.stop_reason) {
            entry.stop_reason = structured.stop_reason;
        }

        const resultText =
            structured.result_brief ||
            structured.error ||
            STATUS_ONLY_RESULT_BRIEFS[structured.status];
        if (resultText) {
            entry.result_brief = boundText(resultText);
            entry.result_ref = String(message.id || toolCallIdStr);
        }
    }

    return order.map((id) => entriesById.get(id)!);
}

// ─── 渲染函数 ──────────────────────────────────────────────────

/**
 * 渲染单个委托条目。
 */
function renderEntryLine(entry: DelegationEntry): string {
    const status = escapeHtml(entry.status);
    const description = escapeHtml(entry.description);
    const subagentType = escapeHtml(entry.subagent_type);
    const guidance = statusGuidance(entry.status, entry.stop_reason);
    let line = `- [${status}] ${description} (via ${subagentType}; ${guidance})`;
    if (entry.result_brief) {
        line += ` -> ${escapeHtml(boundText(entry.result_brief, LEDGER_ENTRY_RESULT_RENDER_CAP))}`;
    }
    return line;
}

/**
 * 渲染委托账本为模型可见的系统上下文。
 *
 * 对应原项目 render_delegation_ledger。
 *
 * 输出示例：
 * ```
 * ## Work already delegated
 * - [completed] 分析 sales.csv (via general-purpose; completed result; reuse this result) -> 分析完成...
 * - [in_progress] 生成报告 (via general-purpose; already delegated; wait for result)
 * ```
 */
export function renderDelegationLedger(
    entries: DelegationEntry[],
    maxChars: number = LEDGER_RENDER_CHAR_BUDGET
): string {
    if (entries.length === 0) return "";

    const lines = [
        "## Work already delegated",
        "Newest entries are shown first. In-progress entries are already delegated. Completed entries are reusable results. Failed, cancelled, or timed-out entries are prior attempts.",
    ];

    let omitted = 0;
    const reversed = [...entries].reverse();

    for (let index = 0; index < reversed.length; index++) {
        const line = renderEntryLine(reversed[index]);
        if (fitsBudget(lines, line, maxChars)) {
            lines.push(line);
            continue;
        }
        omitted = entries.length - index;
        break;
    }

    if (omitted > 0) {
        let omittedLine = `- ... ${omitted} older delegation entries omitted from this model view because of context budget`;
        while (lines.length > 1 && !fitsBudget(lines, omittedLine, maxChars)) {
            lines.pop();
            omitted++;
            omittedLine = `- ... ${omitted} older delegation entries omitted from this model view because of context budget`;
        }
        if (fitsBudget(lines, omittedLine, maxChars)) {
            lines.push(omittedLine);
        }
    }

    const rendered = lines.join("\n");
    if (rendered.length <= maxChars) return rendered;
    return rendered.slice(0, Math.max(0, maxChars - 4)) + "\n...";
}

/**
 * 检查是否超出预算。
 */
function fitsBudget(lines: string[], candidate: string, maxChars: number): boolean {
    return [...lines, candidate].join("\n").length <= maxChars;
}
