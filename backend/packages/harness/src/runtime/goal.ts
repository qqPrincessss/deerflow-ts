/**
 * 目标评估 — 追踪 AI 是否完成了设定目标。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/goal.py
 *
 * 完整功能：
 * - 解析 /goal 命令
 * - 创建和更新目标状态
 * - LLM 评估目标是否达成
 * - 连续无进展检测（no_progress_count + evidence signature）
 * - 继续决策 + 生成继续消息
 * - 目标状态读写（storage 集成）
 * - 线程级写锁（串行化 read-modify-write）
 * - 写冲突检测（乐观锁）
 * - 消息类型安全取值（兼容对象和 dict 两种形态）
 */

import { createHash } from "node:crypto";
import { type GoalState, type GoalEvaluation, type GoalBlocker } from "../agents/goal_state.js";
import { createChatModel } from "../models/factory.js";
import { messageToText as _messageToText } from "../utils/messages.js";
import { stripThinkBlocks, stripMarkdownCodeFence } from "../utils/llm_text.js";
import { getMemoryStorage } from "../agents/memory/storage.js";

/**
 * 安全的 messageToText 包装 —— 兼容 Record<string, unknown> 类型。
 * messageToText 在 TS 版中只用了 message.content 和 message.type，不需要完整的 AIMessage 类型。
 */
function messageToText(msg: Record<string, unknown>): string {
    return _messageToText(msg as unknown as Parameters<typeof _messageToText>[0]);
}

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

export const DEFAULT_MAX_GOAL_CONTINUATIONS = 8;
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
// 异常
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 当目标写入基于过期的 checkpoint 时抛出。
 * 对应 Python GoalWriteConflict。
 */
export class GoalWriteConflict extends Error {
    constructor(threadId: string) {
        super(`Thread ${threadId} goal checkpoint changed while preparing write`);
        this.name = "GoalWriteConflict";
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 线程级写锁
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 当前事件循环 → (thread_id → lock) 的映射。
 * 对应 Python _goal_locks_by_loop: WeakKeyDictionary。
 *
 * 使用 WeakRef 在事件循环被 GC 时自动清理。若 WeakRef 不可用（某些老版本 Node），
 * 兜底到 Map（需要手动清理）。
 */
const _goalLocksByLoop = new Map<object, Map<string, Promise<void>>>();
let _goalLockKey: object | null = null;

function _getEventLoopKey(): object {
    // 每次调用返回同一个对象 —— 只要事件循环不变，key 就不变
    // 在 Node.js 中只有一个事件循环，所以我们用一个固定对象
    if (!_goalLockKey) _goalLockKey = {};
    return _goalLockKey;
}

/**
 * 串行化线程内的目标读-改-写操作。
 * 对应 Python goal_thread_lock。
 *
 * 在同一事件循环中，同一 thread_id 的 goal 操作按顺序执行。
 *
 * @example
 * async function updateGoal(threadId: string) {
 *   using _ = await goalThreadLock(threadId);
 *   const goal = await readThreadGoal(threadId);
 *   // ... modify goal ...
 *   await writeThreadGoal(goal, threadId);
 * }
 */
export async function goalThreadLock(threadId: string): Promise<GoalLockHandle> {
    const loopKey = _getEventLoopKey();
    let locks = _goalLocksByLoop.get(loopKey);
    if (!locks) {
        locks = new Map();
        _goalLocksByLoop.set(loopKey, locks);
    }

    // Build a chain of promises — each caller waits for the previous one
    let prev = locks.get(threadId) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    locks.set(threadId, next);

    await prev;
    return new GoalLockHandle(resolve!);
}

/**
 * 可释放的锁句柄。使用结束后调用 .release() 释放锁。
 * 对应 Python 中 async with lock 的上下文管理器退出。
 */
export class GoalLockHandle {
    private _resolve: () => void;
    private _released = false;

    constructor(resolve: () => void) {
        this._resolve = resolve;
    }

    release(): void {
        if (!this._released) {
            this._released = true;
            this._resolve();
        }
    }

    /** Symbol.dispose 支持（TypeScript 5.2+ using 语法）。 */
    [Symbol.dispose](): void {
        this.release();
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 命令解析
// ════════════════════════════════════════════════════════════════════════════════

export type GoalCommandKind = "status" | "clear" | "set";

export interface GoalCommand {
    kind: GoalCommandKind;
    objective: string;
}

/**
 * 解析 /goal 命令参数字符串。
 * 对应 Python parse_goal_command：
 * - 空字符串 → status
 * - clear/reset/off → clear
 * - 其他 → set
 *
 * TUI 和 IM 通道共享此逻辑，前端在 input-box-helpers.ts 中有对应的 TS 副本。
 */
export function parseGoalCommand(args: string): GoalCommand {
    const stripped = args.trim();
    if (!stripped) return { kind: "status", objective: "" };
    if (GOAL_CLEAR_ALIASES.has(stripped.toLowerCase())) return { kind: "clear", objective: "" };
    return { kind: "set", objective: stripped };
}

// ════════════════════════════════════════════════════════════════════════════════
// 目标状态操作
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 标准化并验证用户设置的目标文本。
 * 对应 Python normalize_goal_objective。
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
 * 对应 Python build_goal_state。
 */
export function buildGoalState(
    objective: string,
    options?: { maxContinuations?: number; maxNoProgressContinuations?: number },
): GoalState {
    const normalized = normalizeGoalObjective(objective);
    const now = new Date().toISOString();
    return {
        objective: normalized,
        status: "active",
        created_at: now,
        updated_at: now,
        continuation_count: 0,
        max_continuations: Math.min(
            options?.maxContinuations ?? DEFAULT_MAX_GOAL_CONTINUATIONS,
            DEFAULT_MAX_GOAL_CONTINUATIONS,
        ),
        no_progress_count: 0,
        max_no_progress_continuations: Math.max(
            0,
            options?.maxNoProgressContinuations ?? DEFAULT_MAX_NO_PROGRESS_CONTINUATIONS,
        ),
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 消息类型安全取值
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 安全获取消息的 type 字段，兼容对象和 dict 两种形态。
 * 对应 Python _message_type：
 * - 先取 message.type
 * - 如果是 dict 且没有 type，尝试 role
 * - assistant → ai, user → human
 */
export function messageType(message: unknown): string | null {
    if (typeof message !== "object" || message === null) return null;
    const msg = message as Record<string, unknown>;
    let value = msg.type;
    if (value === undefined && msg.role) value = msg.role;
    if (value === "assistant") return "ai";
    if (value === "user") return "human";
    return typeof value === "string" ? value : null;
}

/**
 * 安全获取消息的 additional_kwargs，兼容对象和 dict。
 * 对应 Python _additional_kwargs。
 */
export function additionalKwargs(message: unknown): Record<string, unknown> {
    if (typeof message !== "object" || message === null) return {};
    const msg = message as Record<string, unknown>;
    const value = msg.additional_kwargs;
    return (typeof value === "object" && value !== null) ? value as Record<string, unknown> : {};
}

/**
 * 判断消息是否对用户可见。
 * 对应 Python _is_visible_message：
 * - hide_from_ui → 不可见
 * - 只有 human 和 ai 类型可见
 */
export function isVisibleMessage(message: Record<string, unknown>): boolean {
    const kw = additionalKwargs(message);
    if (kw.hide_from_ui === true) return false;
    const type = messageType(message);
    return type === "human" || type === "ai";
}

// ════════════════════════════════════════════════════════════════════════════════
// 目标状态读写（Storage 集成）
// ════════════════════════════════════════════════════════════════════════════════

const GOAL_STORAGE_KEY = "goal_state";

/**
 * 确保目标存储就绪（创建空存储）。
 * 对应 Python ensure_thread_checkpoint 的概念 —— 确保存储存在。
 * 第一次 load 会自动创建，所以此函数主要用于显式初始化。
 */
export async function ensureGoalStorage(): Promise<void> {
    const storage = getMemoryStorage();
    // 触发一次 load 确保存储初始化
    await storage.load();
}

/**
 * 从持久化存储中读取目标状态。
 * 对应 Python read_thread_goal（但使用 memory storage 而非 checkpointer）。
 */
export async function readThreadGoal(
    agentName?: string,
    userId?: string,
): Promise<GoalState | null> {
    try {
        const storage = getMemoryStorage();
        const data = await storage.load(agentName, userId);
        const goal = (data as Record<string, unknown>)[GOAL_STORAGE_KEY];
        if (goal && typeof goal === "object") {
            return goal as GoalState;
        }
    } catch {
        // 没有目标
    }
    return null;
}

/**
 * 写入目标状态到持久化存储。
 * 对应 Python write_thread_goal（但使用 memory storage 而非 checkpointer）。
 *
 * 支持乐观锁检测：通过传入 expectedCheckpointId 确保不是基于过期数据写入。
 * 在没有 LangGraph checkpointer 的 TS 版中，用 updated_at 做版本比较。
 */
export async function writeThreadGoal(
    goal: GoalState | null,
    agentName?: string,
    userId?: string,
    options?: {
        /** 期望的 updated_at 值。不匹配时抛出 GoalWriteConflict。 */
        expectedUpdatedAt?: string | null;
    },
): Promise<void> {
    const storage = getMemoryStorage();
    const data = await storage.load(agentName, userId);
    const record = data as Record<string, unknown>;

    // 乐观锁检测
    if (options?.expectedUpdatedAt !== undefined) {
        const existing = record[GOAL_STORAGE_KEY] as Record<string, unknown> | undefined;
        if (existing && existing.updated_at !== options.expectedUpdatedAt) {
            throw new GoalWriteConflict(agentName ?? "unknown");
        }
    }

    if (goal === null) {
        delete record[GOAL_STORAGE_KEY];
    } else {
        record[GOAL_STORAGE_KEY] = { ...goal, updated_at: new Date().toISOString() };
    }
    await storage.save(data, agentName, userId);
}

// ════════════════════════════════════════════════════════════════════════════════
// 评估结果解析
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
 * 解析评估器返回的 JSON 对象。
 * 对应 Python parse_goal_evaluation_response。
 */
export function parseGoalEvaluationResponse(text: string): GoalEvaluation {
    let cleaned = stripMarkdownCodeFence(stripThinkBlocks(text));
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
        throw new Error("Goal evaluator response did not contain a JSON object.");
    }

    let payload: Record<string, unknown>;
    try { payload = JSON.parse(cleaned.slice(start, end + 1)); }
    catch { throw new Error("Goal evaluator response was not valid JSON."); }

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

// ════════════════════════════════════════════════════════════════════════════════
// 对话格式化
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 计算可见对话的稳定轻量签名。
 * 对应 Python visible_conversation_signature。
 */
export function visibleConversationSignature(messages: Array<Record<string, unknown>>): string {
    const visible: Array<{ role: string | null; text: string }> = [];
    for (const msg of messages) {
        if (!isVisibleMessage(msg)) continue;
        visible.push({
            role: messageType(msg),
            text: messageToText(msg).trim(),
        });
    }
    return JSON.stringify(visible.slice(-MAX_GOAL_CONVERSATION_MESSAGES));
}

/**
 * 格式化用户可见的对话内容供目标评估器使用。
 * 对应 Python format_visible_conversation。
 */
export function formatVisibleConversation(messages: Array<Record<string, unknown>>): string {
    const lines: string[] = [];
    const visible: Array<Record<string, unknown>> = [];
    for (const msg of messages) {
        if (isVisibleMessage(msg)) visible.push(msg);
    }
    const recent = visible.slice(-MAX_GOAL_CONVERSATION_MESSAGES);
    for (const msg of recent) {
        const text = messageToText(msg).trim();
        if (!text) continue;
        const role = messageType(msg) === "human" ? "User" : "Assistant";
        lines.push(`${role}: ${text}`);
    }
    let conversation = lines.join("\n\n");
    if (conversation.length > MAX_GOAL_CONVERSATION_CHARS) {
        conversation = conversation.slice(-MAX_GOAL_CONVERSATION_CHARS);
    }
    return conversation;
}

// ════════════════════════════════════════════════════════════════════════════════
// 无进展检测
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 返回最新的可见 AI 回复的 SHA256 签名。
 * 对应 Python latest_visible_assistant_signature：
 * "no progress" 断路器基于 agent 实际产出的可见内容做签名，
 * 而不是评估器的自由文本 reason/evidence_summary（每次 LLM 都会换词）。
 */
export function latestVisibleAssistantSignature(messages: Array<Record<string, unknown>>): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!isVisibleMessage(msg) || messageType(msg) !== "ai") continue;
        const text = messageToText(msg).trim();
        if (text) return createHash("sha256").update(text, "utf-8").digest("hex");
    }
    return "";
}

/**
 * 返回稳定且可重复的进展检测 key。
 * 对应 Python compute_goal_progress_key：
 * 基于 blocker + evidence signature，而非评估器的自由文本。
 */
export function computeGoalProgressKey(evaluation: GoalEvaluation, evidenceSignature: string = ""): string {
    return JSON.stringify({
        satisfied: evaluation.satisfied,
        blocker: evaluation.blocker,
        evidence_signature: evidenceSignature,
    });
}

/**
 * 当可见证据未推进时递增无进展计数。
 * 对应 Python compute_no_progress_count：
 * - satisfied → 重置为 0
 * - progress_key 与上次相同 → 递增
 * - 其他 → 重置为 0
 */
export function computeNoProgressCount(
    goal: GoalState,
    evaluation: GoalEvaluation,
    evidenceSignature: string = "",
): number {
    if (evaluation.satisfied) return 0;
    const progressKey = computeGoalProgressKey(evaluation, evidenceSignature);
    const previous = goal.last_evaluation;
    if (previous && typeof previous === "object" && (previous as Record<string, unknown>).progress_key === progressKey) {
        return (goal.no_progress_count ?? 0) + 1;
    }
    return 0;
}

// ════════════════════════════════════════════════════════════════════════════════
// 模型工厂
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 创建目标评估器使用的非思考模型。
 * 对应 Python create_goal_evaluator_model。
 *
 * 目标评估使用不需要思考能力的轻量模型，以节省 token 和延迟。
 */
export function createGoalEvaluatorModel(options?: {
    modelName?: string | null;
}): ReturnType<typeof createChatModel> {
    return createChatModel(options?.modelName ?? undefined, false);
}

// ════════════════════════════════════════════════════════════════════════════════
// LLM 评估
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 检查是否有至少一条可见的 AI 回复供评估器审查。
 * 对应 Python has_visible_assistant_evidence。
 */
export function hasVisibleAssistantEvidence(messages: Array<Record<string, unknown>>): boolean {
    return messages.some(
        (m) => messageType(m) === "ai" && isVisibleMessage(m) && messageToText(m).trim(),
    );
}

/**
 * 调用 LLM 评估目标是否完成。
 * 对应 Python evaluate_goal_completion。
 */
export async function evaluateGoalCompletion(
    goal: GoalState,
    messages: Array<Record<string, unknown>>,
    options?: {
        modelName?: string;
        /** 外部传入的 model 实例，为 null 或 undefined 时内部创建。 */
        model?: Awaited<ReturnType<typeof createChatModel>> | null;
    },
): Promise<GoalEvaluation> {
    const conversation = formatVisibleConversation(messages);

    if (!conversation || !hasVisibleAssistantEvidence(messages)) {
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
        "If the visible evidence is too weak to prove progress, fail closed with blocker missing_evidence.",
        "Use blocker needs_user_input when the assistant is waiting on the user, run_failed when the turn failed, ",
        "external_wait when work is waiting on an outside system, goal_not_met_yet when useful autonomous work can continue, ",
        "and none only when satisfied is true.",
        'Output exactly one JSON object: {"satisfied": boolean, "blocker": string, "reason": string, "evidence_summary": string}.',
    ].join(" ");

    const model = options?.model ?? await createChatModel(options?.modelName);
    const response = await model.invoke([
        { type: "human", content: systemInstruction },
        { type: "human", content: `Active goal:\n${goal.objective}\n\nVisible conversation evidence:\n${conversation}\n\nIs the active goal fully satisfied?` },
    ]);

    const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    return parseGoalEvaluationResponse(text);
}

// ════════════════════════════════════════════════════════════════════════════════
// 决策辅助
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 判断是否应该继续目标对话。
 * 对应 Python should_continue_goal：
 * - satisfied → 停止
 * - blocker 不可继续（不在 CONTINUABLE_GOAL_BLOCKERS 中）→ 停止
 * - 超过最大续会话次数 → 停止
 * - 无进展计数超限 → 停止
 */
export function shouldContinueGoal(
    goal: GoalState,
    evaluation: GoalEvaluation,
    noProgressCount?: number,
): boolean {
    if (evaluation.satisfied) return false;
    if (!CONTINUABLE_GOAL_BLOCKERS.has(evaluation.blocker)) return false;
    if (goal.continuation_count >= goal.max_continuations) return false;
    const currentNoProgress = noProgressCount ?? goal.no_progress_count;
    return currentNoProgress < goal.max_no_progress_continuations;
}

/**
 * 生成隐藏的继续消息，让 Agent 继续工作。
 * 对应 Python make_goal_continuation_message。
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
        additional_kwargs: { hide_from_ui: true, deerflow_goal_continuation: true },
    };
}

/**
 * 将评估结果附加到目标状态并返回副本。
 * 对应 Python attach_goal_evaluation。
 */
export function attachGoalEvaluation(
    goal: GoalState,
    evaluation: GoalEvaluation,
    options?: {
        runId?: string;
        continuationCount?: number;
        noProgressCount?: number;
        standDownReason?: string;
        evidenceSignature?: string;
    },
): GoalState {
    const next = { ...goal };
    if (options?.continuationCount !== undefined) next.continuation_count = options.continuationCount;
    if (options?.noProgressCount !== undefined) next.no_progress_count = options.noProgressCount;
    next.updated_at = new Date().toISOString();
    next.last_evaluation = {
        satisfied: evaluation.satisfied,
        blocker: evaluation.blocker,
        reason: evaluation.reason,
        evidence_summary: evaluation.evidence_summary ?? "",
        run_id: options?.runId ?? "",
        evaluated_at: next.updated_at,
        progress_key: computeGoalProgressKey(evaluation, options?.evidenceSignature ?? ""),
    };
    if (options?.standDownReason) {
        (next.last_evaluation as Record<string, unknown>).stand_down_reason = options.standDownReason;
    }
    return next;
}
