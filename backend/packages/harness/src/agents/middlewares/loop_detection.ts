/**
 * 循环检测中间件 — 检测并打断重复的工具调用循环。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py
 *
 * 两层检测：
 *   第 1 层（哈希）：相同工具调用集合重复 → 3 次警告，5 次强制停止
 *   第 2 层（频率）：同一工具类型频繁调用 → 30 次警告，50 次强制停止
 *
 * 设计：
 *   - after_model 检测循环，wrap_model_call 注入警告（见模块文档说明）
 *   - 滑动窗口跟踪最近 N 次工具调用
 *   - LRU 淘汰线程状态
 *   - 强制停止记录 stop_reason="loop_capped" 供执行器读取
 */

import { createHash } from "node:crypto";
import { type LoopDetectionConfig } from "../../config/loop_detection_config.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _DEFAULT_WARN_THRESHOLD = 3;
const _DEFAULT_HARD_LIMIT = 5;
const _DEFAULT_WINDOW_SIZE = 20;
const _DEFAULT_MAX_TRACKED_THREADS = 100;
const _DEFAULT_TOOL_FREQ_WARN = 30;
const _DEFAULT_TOOL_FREQ_HARD_LIMIT = 50;
const _MAX_PENDING_WARNINGS_PER_RUN = 4;

const _WARNING_MSG = "[LOOP DETECTED] You are repeating the same tool calls. Stop calling tools and produce your final answer now. If you cannot complete the task, summarize what you accomplished so far.";

const _TOOL_FREQ_WARNING_MSG =
    "[LOOP DETECTED] You have called {tool_name} {count} times without producing a final answer. Stop calling tools and produce your final answer now. If you cannot complete the task, summarize what you accomplished so far.";

const _HARD_STOP_MSG = "[FORCED STOP] Repeated tool calls exceeded the safety limit. Producing final answer with results collected so far.";

const _TOOL_FREQ_HARD_STOP_MSG = "[FORCED STOP] Tool {tool_name} called {count} times — exceeded the per-tool safety limit. Producing final answer with results collected so far.";

// ════════════════════════════════════════════════════════════════════════════════
// 工具调用哈希
// ════════════════════════════════════════════════════════════════════════════════

function _normalizeToolCallArgs(rawArgs: unknown): [Record<string, unknown>, string | null] {
    if (typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)) {
        return [rawArgs as Record<string, unknown>, null];
    }
    if (typeof rawArgs === "string") {
        try {
            const parsed = JSON.parse(rawArgs);
            if (typeof parsed === "object" && parsed !== null) {
                return [parsed as Record<string, unknown>, null];
            }
            return [{}, JSON.stringify(parsed)];
        } catch {
            return [{}, rawArgs];
        }
    }
    if (rawArgs === undefined || rawArgs === null) return [{}, null];
    return [{}, JSON.stringify(rawArgs)];
}

function _stableToolKey(name: string, args: Record<string, unknown>, fallbackKey: string | null): string {
    // read_file：按路径 + 行范围分桶，避免每次读不同行都算"不同调用"
    if (name === "read_file" && fallbackKey === null) {
        const path = String(args.path ?? "");
        let startLine = args.start_line !== undefined ? Number(args.start_line) : 1;
        let endLine = args.end_line !== undefined ? Number(args.end_line) : startLine;
        if (!isFinite(startLine) || startLine < 1) startLine = 1;
        if (!isFinite(endLine) || endLine < 1) endLine = startLine;
        const [s, e] = [startLine, endLine].sort((a, b) => a - b);
        const bucketSize = 200;
        const bucketStart = Math.floor((Math.max(s, 1) - 1) / bucketSize);
        const bucketEnd = Math.floor((Math.max(e, 1) - 1) / bucketSize);
        return `${path}:${bucketStart}-${bucketEnd}`;
    }

    // write_file / str_replace：内容敏感，用完整 args 哈希
    if (name === "write_file" || name === "str_replace") {
        if (fallbackKey !== null) return fallbackKey;
        return JSON.stringify(args, Object.keys(args).sort());
    }

    // 其他工具：只取关键字段
    const salient = ["path", "url", "query", "command", "pattern", "glob", "cmd"];
    const stable: Record<string, unknown> = {};
    for (const field of salient) {
        if (args[field] !== undefined && args[field] !== null) stable[field] = args[field];
    }
    if (Object.keys(stable).length > 0) return JSON.stringify(stable, Object.keys(stable).sort());
    if (fallbackKey !== null) return fallbackKey;
    return JSON.stringify(args, Object.keys(args).sort());
}

function _hashToolCalls(toolCalls: Array<Record<string, unknown>>): string {
    const normalized: string[] = [];
    for (const tc of toolCalls) {
        const name = String(tc.name ?? "");
        const [args, fallbackKey] = _normalizeToolCallArgs(tc.args);
        const key = _stableToolKey(name, args, fallbackKey);
        normalized.push(`${name}:${key}`);
    }
    normalized.sort();
    const blob = JSON.stringify(normalized);
    return createHash("md5").update(blob).digest("hex").slice(0, 12);
}

// ════════════════════════════════════════════════════════════════════════════════
// 内容辅助
// ════════════════════════════════════════════════════════════════════════════════

function _appendText(content: unknown, text: string): unknown {
    if (content === null || content === undefined) return text;
    if (typeof content === "string") return content + `\n\n${text}`;
    if (Array.isArray(content)) return [...content, { type: "text", text: `\n\n${text}` }];
    return String(content) + `\n\n${text}`;
}

function _buildHardStopUpdate(lastMsg: Record<string, unknown>, content: unknown): Record<string, unknown> {
    const additionalKwargs = { ...((lastMsg.additional_kwargs as Record<string, unknown>) ?? {}) };
    delete additionalKwargs.tool_calls;
    delete additionalKwargs.function_call;

    const responseMetadata = { ...((lastMsg.response_metadata as Record<string, unknown>) ?? {}) };
    if (responseMetadata.finish_reason === "tool_calls") {
        responseMetadata.finish_reason = "stop";
    }

    return {
        tool_calls: [],
        content,
        additional_kwargs: additionalKwargs,
        response_metadata: responseMetadata,
    };
}

function _formatWarningMessage(warnings: string[]): string {
    return [...new Set(warnings)].join("\n\n");
}

// ════════════════════════════════════════════════════════════════════════════════
// LoopDetector 类
// ════════════════════════════════════════════════════════════════════════════════

export class LoopDetector {
    warnThreshold: number;
    hardLimit: number;
    windowSize: number;
    maxTrackedThreads: number;
    toolFreqWarn: number;
    toolFreqHardLimit: number;
    private _toolFreqOverrides: Record<string, [number, number]>;
    private _toolFreqWindow: number;

    // 每线程哈希历史
    private _history = new Map<string, string[]>();
    // 每线程已警告的哈希
    private _warned = new Map<string, Set<string>>();
    // 每线程工具名频率
    private _toolNameHistory = new Map<string, string[]>();
    // 每线程工具名计数器
    private _toolNameCounter = new Map<string, Record<string, number>>();
    // 每线程已频率警告的工具
    private _toolFreqWarned = new Map<string, Set<string>>();
    // 待发送警告队列 (thread_id:run_id) → [警告文本]
    private _pendingWarnings = new Map<string, string[]>();
    private _pendingTouchOrder: string[] = [];
    private _maxPendingWarningKeys: number;

    // 停止原因（供执行器读取）
    private _stopReason = new Map<string, string>();

    constructor(config?: {
        warnThreshold?: number;
        hardLimit?: number;
        windowSize?: number;
        maxTrackedThreads?: number;
        toolFreqWarn?: number;
        toolFreqHardLimit?: number;
        toolFreqOverrides?: Record<string, [number, number]>;
    }) {
        this.warnThreshold = config?.warnThreshold ?? _DEFAULT_WARN_THRESHOLD;
        this.hardLimit = config?.hardLimit ?? _DEFAULT_HARD_LIMIT;
        this.windowSize = config?.windowSize ?? _DEFAULT_WINDOW_SIZE;
        this.maxTrackedThreads = config?.maxTrackedThreads ?? _DEFAULT_MAX_TRACKED_THREADS;
        this.toolFreqWarn = config?.toolFreqWarn ?? _DEFAULT_TOOL_FREQ_WARN;
        this.toolFreqHardLimit = config?.toolFreqHardLimit ?? _DEFAULT_TOOL_FREQ_HARD_LIMIT;
        this._toolFreqOverrides = config?.toolFreqOverrides ?? {};
        this._toolFreqWindow = Math.max(
            this.windowSize,
            this.toolFreqHardLimit,
            ...Object.values(this._toolFreqOverrides).map(([, hard]) => hard),
        );
        this._maxPendingWarningKeys = Math.max(1, this.maxTrackedThreads * 2);
    }

    static fromConfig(config: LoopDetectionConfig): LoopDetector {
        const configRecord = config as Record<string, unknown>;
        const overrides = configRecord.tool_freq_overrides as Record<string, { warn: number; hard_limit: number }> | undefined;
        return new LoopDetector({
            warnThreshold: config.warn_threshold ?? _DEFAULT_WARN_THRESHOLD,
            hardLimit: config.hard_limit ?? _DEFAULT_HARD_LIMIT,
            windowSize: config.window_size ?? _DEFAULT_WINDOW_SIZE,
            maxTrackedThreads: config.max_tracked_threads ?? _DEFAULT_MAX_TRACKED_THREADS,
            toolFreqWarn: config.tool_freq_warn ?? _DEFAULT_TOOL_FREQ_WARN,
            toolFreqHardLimit: config.tool_freq_hard_limit ?? _DEFAULT_TOOL_FREQ_HARD_LIMIT,
            toolFreqOverrides: overrides ? Object.fromEntries(
                Object.entries(overrides).map(([name, o]) => [name, [o.warn, o.hard_limit]]),
            ) : undefined,
        });
    }

    consumeStopReason(runId: string | null): string | null {
        const key = runId ?? "null";
        const reason = this._stopReason.get(key);
        this._stopReason.delete(key);
        return reason ?? null;
    }

    // ── 跟踪与检测 ──────────────────────────────────────────────

    /**
     * 跟踪工具调用并检测循环。
     *
     * @returns [warningText, shouldHardStop]
     */
    trackAndCheck(
        messages: Array<Record<string, unknown>>,
        threadId: string,
    ): [string | null, boolean] {
        if (!messages || messages.length === 0) return [null, false];

        const lastMsg = messages[messages.length - 1];
        if (lastMsg.type !== "ai") return [null, false];

        const toolCalls = lastMsg.tool_calls as Array<Record<string, unknown>> | undefined;
        if (!toolCalls || toolCalls.length === 0) return [null, false];

        const callHash = _hashToolCalls(toolCalls);

        // 获取/创建线程历史
        if (!this._history.has(threadId)) {
            // LRU 淘汰
            if (this._history.size >= this.maxTrackedThreads) {
                const firstKey = this._history.keys().next().value;
                if (firstKey) {
                    this._history.delete(firstKey);
                    this._warned.delete(firstKey);
                    this._toolNameHistory.delete(firstKey);
                    this._toolFreqWarned.delete(firstKey);
                    // 清理 pending
                    for (const k of this._pendingWarnings.keys()) {
                        if (k.startsWith(firstKey + ":")) this._pendingWarnings.delete(k);
                    }
                }
            }
            this._history.set(threadId, []);
        }

        const history = this._history.get(threadId)!;
        history.push(callHash);
        if (history.length > this.windowSize) {
            history.splice(0, history.length - this.windowSize);
        }

        // 清理已警告但不在历史中的哈希
        const warned = this._warned.get(threadId);
        if (warned) {
            const currentHashes = new Set(history);
            for (const h of warned) {
                if (!currentHashes.has(h)) warned.delete(h);
            }
            if (warned.size === 0) this._warned.delete(threadId);
        }

        const count = history.filter((h) => h === callHash).length;
        const toolNames = toolCalls.map((tc) => String(tc.name ?? "?"));

        // ── 第 1 层：哈希检测 ──
        if (count >= this.hardLimit) {
            return [_HARD_STOP_MSG, true];
        }

        if (count >= this.warnThreshold) {
            const warnedSet = this._warned.get(threadId) ?? new Set();
            if (!warnedSet.has(callHash)) {
                warnedSet.add(callHash);
                this._warned.set(threadId, warnedSet);
                return [_WARNING_MSG, false];
            }
        }

        // ── 第 2 层：频率检测 ──
        const toolNameHistory = this._toolNameHistory.get(threadId) ?? [];
        const nameCounter = this._toolNameCounter.get(threadId) ?? {};

        for (const tc of toolCalls) {
            const name = String(tc.name ?? "");
            if (!name) continue;

            toolNameHistory.push(name);
            nameCounter[name] = (nameCounter[name] ?? 0) + 1;
            while (toolNameHistory.length > this._toolFreqWindow) {
                const old = toolNameHistory.shift()!;
                nameCounter[old] = (nameCounter[old] ?? 1) - 1;
                if (nameCounter[old] <= 0) delete nameCounter[old];
            }

            const freqCount = nameCounter[name] ?? 0;
            const [effWarn, effHard] = this._toolFreqOverrides[name] ?? [this.toolFreqWarn, this.toolFreqHardLimit];

            if (freqCount >= effHard) {
                return [_TOOL_FREQ_HARD_STOP_MSG.replace("{tool_name}", name).replace("{count}", String(freqCount)), true];
            }

            if (freqCount >= effWarn) {
                const freqWarned = this._toolFreqWarned.get(threadId) ?? new Set();
                if (!freqWarned.has(name)) {
                    freqWarned.add(name);
                    this._toolFreqWarned.set(threadId, freqWarned);
                    return [_TOOL_FREQ_WARNING_MSG.replace("{tool_name}", name).replace("{count}", String(freqCount)), false];
                }
            } else {
                // 频率降到阈值以下 → 允许下次再警告
                this._toolFreqWarned.get(threadId)?.delete(name);
            }
        }

        this._toolNameHistory.set(threadId, toolNameHistory);
        this._toolNameCounter.set(threadId, nameCounter);

        return [null, false];
    }

    // ── 警告队列 ──────────────────────────────────────────────

    private _pendingKey(threadId: string, runId: string): string {
        return `${threadId}:${runId}`;
    }

    queuePendingWarning(threadId: string, runId: string, warning: string): void {
        const key = this._pendingKey(threadId, runId);
        const warnings = this._pendingWarnings.get(key) ?? [];
        if (!warnings.includes(warning)) warnings.push(warning);
        if (warnings.length > _MAX_PENDING_WARNINGS_PER_RUN) warnings.splice(0, warnings.length - _MAX_PENDING_WARNINGS_PER_RUN);
        this._pendingWarnings.set(key, warnings);

        // LRU touch
        const idx = this._pendingTouchOrder.indexOf(key);
        if (idx !== -1) this._pendingTouchOrder.splice(idx, 1);
        this._pendingTouchOrder.push(key);

        // 淘汰
        while (this._pendingTouchOrder.length > this._maxPendingWarningKeys) {
            const evicted = this._pendingTouchOrder.shift();
            if (evicted && evicted !== key) this._pendingWarnings.delete(evicted);
        }
    }

    drainPendingWarnings(threadId: string, runId: string): string[] {
        const key = this._pendingKey(threadId, runId);
        const warnings = this._pendingWarnings.get(key) ?? [];
        this._pendingWarnings.delete(key);
        const idx = this._pendingTouchOrder.indexOf(key);
        if (idx !== -1) this._pendingTouchOrder.splice(idx, 1);
        return warnings;
    }

    clearOtherRunPendingWarnings(threadId: string, currentRunId: string): void {
        for (const key of this._pendingWarnings.keys()) {
            const [tid, rid] = key.split(":");
            if (tid === threadId && rid !== currentRunId) {
                this._pendingWarnings.delete(key);
                const idx = this._pendingTouchOrder.indexOf(key);
                if (idx !== -1) this._pendingTouchOrder.splice(idx, 1);
            }
        }
    }

    clearCurrentRunPendingWarnings(threadId: string, runId: string): void {
        const key = this._pendingKey(threadId, runId);
        this._pendingWarnings.delete(key);
        const idx = this._pendingTouchOrder.indexOf(key);
        if (idx !== -1) this._pendingTouchOrder.splice(idx, 1);
    }

    // ── 主入口 ──────────────────────────────────────────────

    /**
     * 模型调用后处理。
     * 检测循环，记录停止原因或入队警告。
     */
    apply(
        messages: Array<Record<string, unknown>>,
        threadId: string,
        runId: string,
    ): Record<string, unknown> | null {
        const [warning, hardStop] = this.trackAndCheck(messages, threadId);

        if (hardStop) {
            this._stopReason.set(runId, "loop_capped");
            const lastMsg = messages[messages.length - 1];
            const content = _appendText(lastMsg.content, warning ?? _HARD_STOP_MSG);
            const update = _buildHardStopUpdate(lastMsg, content);
            return { messages: [{ ...lastMsg, ...update }] };
        }

        if (warning) {
            this.queuePendingWarning(threadId, runId, warning);
            return null;
        }

        return null;
    }

    /**
     * 在模型调用前注入待发送的警告。
     */
    augmentRequest(
        messages: Array<Record<string, unknown>>,
        threadId: string,
        runId: string,
    ): Array<Record<string, unknown>> | null {
        const warnings = this.drainPendingWarnings(threadId, runId);
        if (warnings.length === 0) return null;

        return [
            ...messages,
            {
                type: "human",
                content: _formatWarningMessage(warnings),
                name: "loop_warning",
            },
        ];
    }

    /**
     * 重置跟踪状态。
     */
    reset(threadId?: string): void {
        if (threadId) {
            this._history.delete(threadId);
            this._warned.delete(threadId);
            this._toolNameHistory.delete(threadId);
            this._toolFreqWarned.delete(threadId);
            for (const key of this._pendingWarnings.keys()) {
                if (key.startsWith(threadId + ":")) {
                    this._pendingWarnings.delete(key);
                    const idx = this._pendingTouchOrder.indexOf(key);
                    if (idx !== -1) this._pendingTouchOrder.splice(idx, 1);
                }
            }
        } else {
            this._history.clear();
            this._warned.clear();
            this._toolNameHistory.clear();
            this._toolFreqWarned.clear();
            this._pendingWarnings.clear();
            this._pendingTouchOrder = [];
            this._stopReason.clear();
        }
    }
}
