/**
 * 运行日志 — 捕获 LLM 调用、Token 用量和运行事件。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/journal.py
 */

// ════════════════════════════════════════════════════════════════════════════════
// 运行事件
// ════════════════════════════════════════════════════════════════════════════════

export interface RunEvent {
    thread_id: string;
    run_id: string;
    event_type: string;
    category: string;
    content: unknown;
    metadata: Record<string, unknown>;
    created_at: string;
}

// ════════════════════════════════════════════════════════════════════════════════
// RunJournal
// ════════════════════════════════════════════════════════════════════════════════

export class RunJournal {
    readonly runId: string;
    readonly threadId: string;

    _buffer: RunEvent[] = [];
    private _flushThreshold: number;
    private _flushHandler?: (events: RunEvent[]) => Promise<void>;

    // Token 用量
    private _totalInputTokens = 0;
    private _totalOutputTokens = 0;
    private _totalTokens = 0;
    private _llmCallCount = 0;

    // 按调用方分类
    private _leadAgentTokens = 0;
    private _subagentTokens = 0;
    private _middlewareTokens = 0;

    // 按模型分类
    private _tokensByModel: Record<string, { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number }> = {};

    // 去重
    private _countedLlmRunIds = new Set<string>();
    private _countedExternalSourceIds = new Set<string>();

    // 便捷字段
    private _lastAiMsg: string | null = null;
    private _firstHumanMsg: string | null = null;
    private _msgCount = 0;
    private _hadLlmErrorFallback = false;
    private _llmErrorFallbackMessage: string | null = null;

    constructor(options: {
        runId: string;
        threadId: string;
        flushThreshold?: number;
        flushHandler?: (events: RunEvent[]) => Promise<void>;
    }) {
        this.runId = options.runId;
        this.threadId = options.threadId;
        this._flushThreshold = options.flushThreshold ?? 20;
        this._flushHandler = options.flushHandler;
    }

    // ── 事件记录 ──────────────────────────────────────────────

    private _put(eventType: string, category: string, content: unknown, metadata?: Record<string, unknown>): void {
        this._buffer.push({
            thread_id: this.threadId,
            run_id: this.runId,
            event_type: eventType,
            category,
            content,
            metadata: metadata ?? {},
            created_at: new Date().toISOString(),
        });

        if (this._buffer.length >= this._flushThreshold) {
            this._flush().catch(() => {});
        }
    }

    private async _flush(): Promise<void> {
        if (!this._flushHandler || this._buffer.length === 0) return;
        const batch = this._buffer.splice(0);
        try {
            await this._flushHandler(batch);
        } catch {
            this._buffer = [...batch, ...this._buffer];
        }
    }

    async flush(): Promise<void> {
        await this._flush();
    }

    // ── Token 记录 ────────────────────────────────────────────

    recordUsage(options: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        runId?: string;
        caller?: string;
        modelName?: string | null;
        cacheReadTokens?: number;
    }): void {
        const { inputTokens, outputTokens, totalTokens, runId, caller, modelName, cacheReadTokens } = options;
        const rid = runId ?? `call_${this._llmCallCount}`;

        if (this._countedLlmRunIds.has(rid)) return;

        this._countedLlmRunIds.add(rid);
        this._totalInputTokens += inputTokens;
        this._totalOutputTokens += outputTokens;
        this._totalTokens += totalTokens;
        this._llmCallCount++;

        if (caller?.startsWith("subagent:")) this._subagentTokens += totalTokens;
        else if (caller?.startsWith("middleware:")) this._middlewareTokens += totalTokens;
        else this._leadAgentTokens += totalTokens;

        // 按模型分类
        const bucket = this._tokensByModel[modelName ?? "unknown"] ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        bucket.input_tokens += inputTokens;
        bucket.output_tokens += outputTokens;
        bucket.total_tokens += totalTokens;
        if (cacheReadTokens && cacheReadTokens > 0) {
            bucket.cache_read_tokens = (bucket.cache_read_tokens ?? 0) + cacheReadTokens;
        }
    }

    recordExternalUsage(records: Array<Record<string, unknown>>): void {
        for (const record of records) {
            const sourceId = String(record.source_run_id ?? "");
            if (!sourceId || this._countedExternalSourceIds.has(sourceId)) continue;

            let totalTk = (record.total_tokens as number) ?? 0;
            if (totalTk <= 0) {
                totalTk = ((record.input_tokens as number) ?? 0) + ((record.output_tokens as number) ?? 0);
            }
            if (totalTk <= 0) continue;

            const inputTk = (record.input_tokens as number) ?? 0;
            const outputTk = (record.output_tokens as number) ?? 0;

            this._countedExternalSourceIds.add(sourceId);
            this._totalInputTokens += inputTk;
            this._totalOutputTokens += outputTk;
            this._totalTokens += totalTk;

            const caller = String(record.caller ?? "");
            if (caller.startsWith("subagent:")) this._subagentTokens += totalTk;
            else if (caller.startsWith("middleware:")) this._middlewareTokens += totalTk;
            else this._leadAgentTokens += totalTk;

            const cacheRead = (record.cache_read_tokens as number) ?? 0;
            this._recordModelUsage(record.model_name as string | undefined, inputTk, outputTk, totalTk, cacheRead);
        }
    }

    private _recordModelUsage(
        modelName: string | undefined,
        input: number,
        output: number,
        total: number,
        cacheRead: number = 0,
    ): void {
        const bucket = this._tokensByModel[modelName ?? "unknown"] ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        bucket.input_tokens += input;
        bucket.output_tokens += output;
        bucket.total_tokens += total;
        if (cacheRead > 0) bucket.cache_read_tokens = (bucket.cache_read_tokens ?? 0) + cacheRead;
    }

    // ── 消息摘要 ──────────────────────────────────────────────

    recordMessageSummary(messageType: string, content: string, caller?: string): void {
        this._msgCount++;
        if (messageType === "ai" && (!caller || caller === "lead_agent")) {
            const text = content.trim();
            if (text) this._lastAiMsg = text.slice(0, 2000);
        }
    }

    setFirstHumanMessage(content: string): void {
        this._firstHumanMsg = content.slice(0, 2000) || null;
    }

    setErrorFallback(detail?: string, reason?: string, text?: string): void {
        this._hadLlmErrorFallback = true;
        if (detail?.trim()) this._llmErrorFallbackMessage = detail.trim().slice(0, 2000);
        else if (reason?.trim()) this._llmErrorFallbackMessage = reason.trim().slice(0, 2000);
        else if (text?.trim()) this._llmErrorFallbackMessage = text.trim().slice(0, 2000);
    }

    // ── 中间件事件 ─────────────────────────────────────────────

    recordMiddleware(tag: string, name: string, hook: string, action: string, changes: Record<string, unknown>): void {
        this._put(`middleware:${tag}`, "middleware", { name, hook, action, changes });
    }

    // ── 完成数据 ─────────────────────────────────────────────

    getCompletionData(): Record<string, unknown> {
        return {
            total_input_tokens: this._totalInputTokens,
            total_output_tokens: this._totalOutputTokens,
            total_tokens: this._totalTokens,
            llm_call_count: this._llmCallCount,
            lead_agent_tokens: this._leadAgentTokens,
            subagent_tokens: this._subagentTokens,
            middleware_tokens: this._middlewareTokens,
            token_usage_by_model: Object.fromEntries(
                Object.entries(this._tokensByModel).map(([m, u]) => [m, { ...u }]),
            ),
            message_count: this._msgCount,
            last_ai_message: this._lastAiMsg,
            first_human_message: this._firstHumanMsg,
        };
    }

    get hadLlmErrorFallback(): boolean {
        return this._hadLlmErrorFallback;
    }

    get llmErrorFallbackMessage(): string | null {
        return this._llmErrorFallbackMessage;
    }
}
