/**
 * 目标评估 — 追踪 AI 是否完成了设定目标。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/goal.py
 *
 * 核心逻辑：
 * 1. 设定目标（/goal 命令）
 * 2. 每次对话后评估目标是否达成
 * 3. 未达成时自动继续对话
 * 4. 检测无进展的死循环
 */

import { type GoalState, type GoalEvaluation, type GoalBlocker } from "../agents/goal_state.js";
import { createChatModel } from "../models/factory.js";
import { messageToText } from "../utils/messages.js";
import { stripThinkBlocks, stripMarkdownCodeFence } from "../utils/llm_text.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_GOAL_CONTINUATIONS = 8;
const DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS = 2;
const MAX_GOAL_OBJECTIVE_CHARS = 4000;
const MAX_GOAL_REASON_CHARS = 1000;
const MAX_GOAL_EVIDENCE_CHARS = 1000;
const MAX_GOAL_CONVERSATION_CHARS = 12000;
const MAX_GOAL_CONVERSATION_MESSAGES = 30;

const GOAL_BLOCKERS = new Set<GoalBlocker>([
    "none", "missing_evidence", "needs_user_input",
    "run_failed", "external_wait", "goal_not_met_yet",
]);
const CONTINUABLE_GOAL_BLOCKERS = new Set<GoalBlocker>(["goal_not_met_yet"]);
const GOAL_CLEAR_ALIASES = new Set(["clear", "reset", "off"]);

// ════════════════════════════════════════════════════════════════════════════════
// 命令解析
// ════════════════════════════════════════════════════════════════════════════════

export type GoalCommandKind = "status" | "clear" | "set";

export interface GoalCommand {
    kind: GoalCommandKind;
    objective: string;
}

/**
 * 解析 /goal 命令。
 */
export function parseGoalCommand(args: string): GoalCommand {
    const stripped = args.trim();
    if (!stripped) return { kind: "status", objective: "" };
    if (GOAL_CLEAR_ALIASES.has(stripped.toLowerCase())) return { kind: "clear", objective: "" };
    return { kind: "set", objective: stripped };
}

// ════════════════════════════════════════════════════════════════════════════════
// 目标状态
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 标准化目标文本。
 */
export function normalizeGoalObjective(objective: string): string {
    const normalized = objective.trim().replace(/\s+/g, " ");
    if (!normalized) throw new Error("Goal objective must not be empty.");
    if (normalized.length > MAX_GOAL_OBJECTIVE_CHARS) {
        throw new Error(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters.`);
    }
    return normalized;
}

/**
 * 创建新的活动目标状态。
 */
export function buildGoalState(
    objective: string,
    options?: {
        maxContinuations?: number;
        maxNoProgressContinuations?: number;
    },
): GoalState {
    const normalized = normalizeGoalObjective(objective);
    const now = new Date().toISOString();
    return {
        objective: normalized,
        status: "active",
        created_at: now,
        updated_at: now,
        continuation_count: 0,
        max_continuations: Math.min(options?.maxContinuations ?? DEFAULT_MAX_GOAL_CONTINUATIONS, DEFAULT_MAX_GOAL_CONTINUATIONS),
        no_progress_count: 0,
        max_no_progress_continuations: Math.max(0, options?.maxNoProgressContinuations ?? DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS),
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 评估
// ════════════════════════════════════════════════════════════════════════════════

function _normalizeEvalText(value: unknown, maxChars: number): string {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\s+/g, " ").slice(0, maxChars);
}

function _normalizeGoalBlocker(value: unknown, satisfied: boolean): GoalBlocker {
    if (satisfied) return "none";
    if (typeof value === "string" && GOAL_BLOCKERS.has(value as GoalBlocker) && value !== "none") {
        return value as GoalBlocker;
    }
    return "missing_evidence";
}

/**
 * 解析 LLM 评估返回的 JSON。
 */
export function parseGoalEvaluationResponse(text: string): GoalEvaluation {
    let cleaned = stripMarkdownCodeFence(stripThinkBlocks(text));
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
        throw new Error("Goal evaluator response did not contain a JSON object.");
    }

    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        throw new Error("Goal evaluator response was not valid JSON.");
    }

    if (typeof payload !== "object" || payload === null) {
        throw new Error("Goal evaluator JSON must be an object.");
    }

    const satisfied = payload.satisfied;
    if (typeof satisfied !== "boolean") {
        throw new Error("Goal evaluator JSON must include boolean 'satisfied'.");
    }

    return {
        satisfied,
        blocker: _normalizeGoalBlocker(payload.blocker, satisfied),
        reason: _normalizeEvalText(payload.reason, MAX_GOAL_REASON_CHARS),
        evidence_summary: _normalizeEvalText(payload.evidence_summary, MAX_GOAL_EVIDENCE_CHARS),
    };
}

/**
 * 格式化可见对话供评估。
 */
export function formatVisibleConversation(messages: Array<Record<string, unknown>>): string {
    const lines: string[] = [];
    let count = 0;
    for (let i = messages.length - 1; i >= 0 && count < MAX_GOAL_CONVERSATION_MESSAGES; i--) {
        const msg = messages[i];
        if (msg.additional_kwargs && (msg.additional_kwargs as Record<string, unknown>).hide_from_ui) continue;
        if (msg.type !== "human" && msg.type !== "ai") continue;
        const text = messageToText({ content: msg.content } as any).trim();
        if (!text) continue;
        const role = msg.type === "human" ? "User" : "Assistant";
        lines.unshift(`${role}: ${text}`);
        count++;
    }

    let conversation = lines.join("\n\n");
    if (conversation.length > MAX_GOAL_CONVERSATION_CHARS) {
        conversation = conversation.slice(-MAX_GOAL_CONVERSATION_CHARS);
    }
    return conversation;
}

/**
 * 调用 LLM 评估目标是否完成。
 */
export async function evaluateGoalCompletion(
    goal: GoalState,
    messages: Array<Record<string, unknown>>,
    options?: {
        modelName?: string;
    },
): Promise<GoalEvaluation> {
    const conversation = formatVisibleConversation(messages);

    // 检查是否有可见的 AI 回复
    const hasAiEvidence = messages.some(
        (m) => m.type === "ai" && messageToText({ content: m.content } as any).trim(),
    );
    if (!conversation || !hasAiEvidence) {
        return {
            satisfied: false,
            blocker: "missing_evidence",
            reason: "No visible assistant evidence is available yet.",
            evidence_summary: "",
        };
    }

    const systemInstruction = [
        "You are a strict completion evaluator for an AI coding assistant.",
        "Decide whether the active goal is fully satisfied using ONLY the visible conversation evidence.",
        "Do not assume files, commands, tests, or external state changed unless the conversation explicitly shows it.",
        'Output exactly one JSON object: {"satisfied": boolean, "blocker": string, "reason": string, "evidence_summary": string}.',
    ].join(" ");

    const userContent = [
        `Active goal:\n${goal.objective}`,
        "",
        "Visible conversation evidence:",
        conversation,
        "",
        "Is the active goal fully satisfied?",
    ].join("\n");

    const model = await createChatModel(options?.modelName);
    const response = await model.invoke([
        { type: "system", content: systemInstruction },
        { type: "human", content: userContent },
    ]);

    const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    return parseGoalEvaluationResponse(text);
}

// ════════════════════════════════════════════════════════════════════════════════
// 决策辅助
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 判断是否应该继续目标对话。
 */
export function shouldContinueGoal(goal: GoalState, evaluation: GoalEvaluation): boolean {
    if (evaluation.satisfied) return false;
    if (!CONTINUABLE_GOAL_BLOCKERS.has(evaluation.blocker)) return false;
    if (goal.continuation_count >= goal.max_continuations) return false;
    return goal.no_progress_count < goal.max_no_progress_continuations;
}

/**
 * 生成目标继续消息。
 */
export function makeGoalContinuationMessage(goal: GoalState, evaluation: GoalEvaluation): Record<string, unknown> {
    return {
        type: "human",
        content: [
            "<goal_continuation>",
            `Active goal: ${goal.objective}`,
            `Evaluator result: not satisfied. Blocker: ${evaluation.blocker}. Reason: ${evaluation.reason || "No reason provided."}`,
            `Visible evidence: ${evaluation.evidence_summary || "No evidence summary provided."}`,
            "Continue working toward the active goal. Use the available tools and conversation context. ",
            "Do not ask the user to continue unless you are genuinely blocked.",
            "</goal_continuation>",
        ].join("\n"),
        additional_kwargs: {
            hide_from_ui: true,
            deerflow_goal_continuation: true,
        },
    };
}
