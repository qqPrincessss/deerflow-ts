/**
 * 工具进度中间件 — 状态机驱动的工具停滞检测（RFC #3177）。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/tool_progress_middleware.py
 *
 * 检测规则：
 *   每个（thread_id, tool_name）有一个状态机：
 *   ACTIVE → WARNED（连续 stagnation_threshold 次问题后）
 *   WARNED → BLOCKED（再连续 warn_escalation_count 次问题后，仅不可恢复的错误）
 *
 *   无问题的调用重置 consecutive_problems=0，回到 ACTIVE。
 *
 * 与 LoopDetectionMiddleware 的分工：
 *   ToolProgressMiddleware（位置 10）是结果质量门控 — 工具执行后检查结果
 *   LoopDetectionMiddleware（位置 23）是调用模式门控 — 模型回复后检查工具调用签名
 */

import { type ToolResultMeta, TOOL_META_KEY } from "./tool_result_meta.js";

/**
 * 安全反序列化 ToolResultMeta，schema 不匹配时返回 null。
 */
function _parseToolMeta(metaRaw: unknown): ToolResultMeta | null {
    if (!metaRaw || typeof metaRaw !== "object") return null;
    const d = metaRaw as Record<string, unknown>;

    const status = d.status;
    if (status !== "success" && status !== "error" && status !== "partial_success") return null;

    const errorType = typeof d.error_type === "string" ? d.error_type : null;
    const recoverable = typeof d.recoverable_by_model === "boolean" ? d.recoverable_by_model : true;
    const nextAction = d.recommended_next_action;
    if (nextAction !== "continue" && nextAction !== "rewrite_query" && nextAction !== "try_alternative" && nextAction !== "summarize" && nextAction !== "stop") return null;

    const source = d.source;
    if (source !== "exception" && source !== "tool_return" && source !== "content_analysis" && source !== "progress_middleware") return null;

    return {
        status,
        error_type: errorType,
        recoverable_by_model: recoverable,
        recommended_next_action: nextAction,
        source,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _MAX_PENDING_PER_RUN = 3;
const _MAX_CONTENT_FOR_WORDSET = 8192;

// ════════════════════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════════════════════

type Phase = "active" | "warned" | "blocked";

interface ToolPhaseState {
    phase: Phase;
    consecutive_problems: number;
    block_reason: string | null;
    recent_word_sets: Array<Set<string>>;
}

function newPhaseState(): ToolPhaseState {
    return {
        phase: "active",
        consecutive_problems: 0,
        block_reason: null,
        recent_word_sets: [],
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 内容辅助
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从内容中提取长度 >=3 的小写单词。
 * 内容截断到 _MAX_CONTENT_FOR_WORDSET 字符。
 */
function wordSet(content: string): Set<string> {
    const slice = content.slice(0, _MAX_CONTENT_FOR_WORDSET).toLowerCase();
    const words = slice.match(/\b\w{3,}\b/g);
    return new Set(words ?? []);
}

/**
 * Jaccard 相似度检测：当前结果是否与最近的结果重复。
 */
function isNearDuplicate(
    current: Set<string>,
    recent: Array<Set<string>>,
    threshold: number,
    minWords: number,
): boolean {
    if (current.size < minWords) return false;
    const last3 = recent.slice(-3);
    for (const prev of last3) {
        if (prev.size < minWords) continue;
        const union = new Set([...current, ...prev]);
        if (union.size === 0) continue;
        const intersection = new Set([...current].filter((x) => prev.has(x)));
        if (intersection.size / union.size >= threshold) return true;
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════════
// 消息格式化
// ════════════════════════════════════════════════════════════════════════════════

function _formatHint(meta: ToolResultMeta): string {
    const actionMap: Record<string, string> = {
        rewrite_query: "Try rephrasing your search query with different keywords or approach.",
        try_alternative: "Consider using a different tool or strategy.",
        summarize: "Consider summarizing your current findings and moving forward.",
        stop: "Do not retry this operation — it is not recoverable.",
        continue: "Try rephrasing your query or using a different search term.",
    };

    const status = meta.error_type ?? meta.status ?? "";
    const base: Record<string, string> = {
        no_results: "[PROGRESS HINT] Your search returned no results.",
        not_found: "[PROGRESS HINT] The resource was not found repeatedly.",
        rate_limited: "[PROGRESS HINT] The tool is being rate-limited.",
        transient: "[PROGRESS HINT] The tool encountered repeated transient failures.",
        partial_success: "[PROGRESS HINT] The tool has returned incomplete results multiple times.",
        success: "[PROGRESS HINT] The tool is returning duplicate results.",
    };

    const prefix = base[status] ?? "[PROGRESS HINT] The tool is not producing new information.";
    const suffix = actionMap[meta.recommended_next_action ?? ""] ?? "";
    return `${prefix} ${suffix}`.trim();
}

function _blockReason(meta: ToolResultMeta): string {
    const map: Record<string, string> = {
        no_results: "Repeated no-results — rewrite your query or try a different tool.",
        not_found: "Repeated not-found — rewrite your query or try a different resource.",
        rate_limited: "Repeated rate-limiting — summarize current findings and proceed.",
        transient: "Repeated transient failures — try a different approach.",
        auth: "Authentication failure — this tool cannot be used.",
        config: "Tool is not configured — this tool cannot be used.",
        internal: "Repeated internal errors — this tool is unavailable.",
    };
    return map[meta.error_type ?? ""] ?? "Tool has not produced new information after multiple attempts — summarize and move on.";
}

// ════════════════════════════════════════════════════════════════════════════════
// 状态机
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 评估工具结果并转换状态机。
 *
 * @returns [new_state, hint_text_or_null]
 */
function _assessAndTransition(
    state: ToolPhaseState,
    meta: ToolResultMeta,
    content: string,
    stagnationThreshold: number,
    warnEscalation: number,
    jaccardThreshold: number,
    minWords: number,
): [ToolPhaseState, string | null] {
    // BLOCKED 是终态
    if (state.phase === "blocked") return [state, null];

    const newCount = state.consecutive_problems + 1;

    // 不可恢复的 stop 信号 → 立即 BLOCKED
    if (!meta.recoverable_by_model && meta.recommended_next_action === "stop") {
        return [
            { ...state, phase: "blocked", consecutive_problems: newCount, block_reason: _blockReason(meta) },
            null,
        ];
    }

    // 只对 success 结果算 word set
    const ws = meta.status === "success" ? wordSet(content) : new Set<string>();
    const isProblem =
        meta.status === "error" ||
        meta.status === "partial_success" ||
        (meta.status === "success" && isNearDuplicate(ws, state.recent_word_sets, jaccardThreshold, minWords));

    if (!isProblem) {
        // 好结果：重置计数
        const newRecent = [...state.recent_word_sets, ws].slice(-3);
        return [{ ...state, consecutive_problems: 0, phase: "active", recent_word_sets: newRecent }, null];
    }

    let hint: string | null = null;
    let newState: ToolPhaseState;

    if (newCount >= stagnationThreshold + warnEscalation) {
        if (meta.recoverable_by_model) {
            hint = _formatHint(meta);
            newState = { ...state, consecutive_problems: newCount, phase: "warned" };
        } else {
            const reason = _blockReason(meta);
            newState = { ...state, consecutive_problems: newCount, phase: "blocked", block_reason: reason };
        }
    } else if (newCount >= stagnationThreshold) {
        hint = _formatHint(meta);
        newState = { ...state, consecutive_problems: newCount, phase: "warned" };
    } else {
        newState = { ...state, consecutive_problems: newCount };
    }

    return [newState, hint];
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具进度管理器
// ════════════════════════════════════════════════════════════════════════════════

const DEFAULT_EXEMPT_TOOLS = new Set(["ask_clarification", "write_todos", "present_files", "task"]);

export class ToolProgressTracker {
    private _stagnationThreshold: number;
    private _warnEscalation: number;
    private _jaccardThreshold: number;
    private _minWords: number;
    private _exemptTools: Set<string>;
    private _maxTrackedThreads: number;

    /** thread_id → { tool_name → ToolPhaseState } */
    private _phaseStates = new Map<string, Map<string, ToolPhaseState>>();
    /** (thread_id, run_id) → [hint texts] */
    private _pending = new Map<string, string[]>();

    constructor(options?: {
        stagnationThreshold?: number;
        warnEscalation?: number;
        jaccardThreshold?: number;
        minWords?: number;
        exemptTools?: string[];
        maxTrackedThreads?: number;
    }) {
        this._stagnationThreshold = options?.stagnationThreshold ?? 3;
        this._warnEscalation = options?.warnEscalation ?? 2;
        this._jaccardThreshold = options?.jaccardThreshold ?? 0.8;
        this._minWords = options?.minWords ?? 10;
        this._exemptTools = options?.exemptTools ? new Set(options.exemptTools) : DEFAULT_EXEMPT_TOOLS;
        this._maxTrackedThreads = options?.maxTrackedThreads ?? 100;
    }

    // -- 内部辅助 -----------------------------------------------------------

    private _getState(threadId: string, toolName: string): ToolPhaseState {
        if (!this._phaseStates.has(threadId)) {
            // LRU 淘汰
            if (this._phaseStates.size >= this._maxTrackedThreads) {
                const firstKey = this._phaseStates.keys().next().value;
                if (firstKey !== undefined) {
                    this._phaseStates.delete(firstKey);
                    // 同时清除该线程的 pending
                    for (const key of this._pending.keys()) {
                        if (key.startsWith(firstKey + ":")) this._pending.delete(key);
                    }
                }
            }
            this._phaseStates.set(threadId, new Map());
        }
        // 移到末尾（LRU 更新）
        const tools = this._phaseStates.get(threadId)!;
        if (!tools.has(toolName)) {
            tools.set(toolName, newPhaseState());
        }
        return tools.get(toolName)!;
    }

    private _setState(threadId: string, toolName: string, state: ToolPhaseState): void {
        const tools = this._phaseStates.get(threadId);
        if (tools) tools.set(toolName, state);
    }

    // -- 公开 API -----------------------------------------------------------

    /** 获取工具是否被 blocked */
    isBlocked(threadId: string, toolName: string): string | null {
        const tools = this._phaseStates.get(threadId);
        if (!tools) return null;
        const state = tools.get(toolName);
        if (!state || state.phase !== "blocked") return null;
        return state.block_reason;
    }

    /** 处理工具结果，更新状态机 */
    processResult(
        threadId: string,
        runId: string,
        toolName: string,
        result: Record<string, unknown>,
    ): Record<string, unknown> {
        if (this._exemptTools.has(toolName)) return result;

        // 解析 tool meta（安全反序列化）
        const additionalKwargs = (result.additional_kwargs as Record<string, unknown>) ?? {};
        const metaRaw = additionalKwargs[TOOL_META_KEY];
        const meta = _parseToolMeta(metaRaw);
        if (meta === null) return result;

        const state = this._getState(threadId, toolName);
        const content = typeof result.content === "string" ? result.content : "";

        const [newState, hint] = _assessAndTransition(
            state,
            meta,
            content,
            this._stagnationThreshold,
            this._warnEscalation,
            this._jaccardThreshold,
            this._minWords,
        );

        this._setState(threadId, toolName, newState);

        if (hint) {
            this._queueHint(threadId, runId, hint);
        }

        return result;
    }

    /** 获取并清空待发送的提示 */
    drainHints(threadId: string, runId: string): string[] {
        const key = `${threadId}:${runId}`;
        const hints = this._pending.get(key) ?? [];
        this._pending.delete(key);
        return hints;
    }

    /** 入队提示 */
    private _queueHint(threadId: string, runId: string, text: string): void {
        const key = `${threadId}:${runId}`;
        if (!this._phaseStates.has(threadId)) return; // 防止为已淘汰的线程创建 pending
        const queue = this._pending.get(key) ?? [];
        if (queue.length < _MAX_PENDING_PER_RUN) {
            queue.push(text);
            this._pending.set(key, queue);
        }
    }

    /** 清理过期 pending */
    clearStalePending(threadId: string, currentRunId: string): void {
        for (const key of this._pending.keys()) {
            const [tid, rid] = key.split(":");
            if (tid === threadId && rid !== currentRunId) {
                this._pending.delete(key);
            }
        }
    }

    /** 重置线程的所有工具状态（新 run 开始时） */
    resetRunStates(threadId: string): void {
        const tools = this._phaseStates.get(threadId);
        if (!tools) return;
        for (const [name] of tools) {
            tools.set(name, newPhaseState());
        }
    }
}
