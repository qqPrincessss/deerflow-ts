/**
 * 运行日志 — 通过 LangChain 回调机制捕获 LLM 调用、Token 用量和运行事件。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/journal.py
 *
 * 继承 BaseCallbackHandler，通过 LangChain 的回调体系自动捕获事件，
 * 无需手动调用 recordUsage 等方法。
 *
 * 功能：
 * - Token 用量追踪（按调用方、按模型分类）
 * - 事件缓冲 + 批量写入
 * - 进度报告推送（节流 + 延迟调度）
 * - LLM 错误回退检测
 * - 工具调用归因与 reconcile
 * - LLM 调用耗时追踪
 * - 调用方识别（通过 tags: lead_agent / subagent:name / middleware:name）
 * - 人类输入消息过滤与持久化
 * - 跨调用去重（同一 run_id 多次回调）
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ChainValues } from "@langchain/core/utils/types";
import type { BaseMessage, ToolMessage } from "@langchain/core/messages";
import { type ChatGeneration, type LLMResult } from "@langchain/core/outputs";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 遗留摘要消息的 name 值，不持久化到 run 记录中。 */
const _LEGACY_SUMMARY_MESSAGE_NAME = "summary";

/** 需要在 run.end 时从输出中 reconcile 的工具消息名称集合。 */
const _RECONCILED_TOOL_MESSAGE_NAMES = new Set(["ask_clarification"]);

/** 即使设置了 hide_from_ui 也应持久化的人类输入来源。 */
const _PERSISTED_HIDDEN_HUMAN_INPUT_RESPONSE_SOURCES = new Set(["ask_clarification"]);

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

/**
 * LangChain 回调处理器，捕获 LLM 调用事件并记录到 RunEventStore。
 */
export class RunJournal extends BaseCallbackHandler {
    name = "RunJournal";

    readonly runId: string;
    readonly threadId: string;

    _buffer: RunEvent[] = [];
    private _flushThreshold: number;
    private _flushHandler?: (events: RunEvent[]) => Promise<void>;
    private _pendingFlushTasks = new Set<Promise<void>>();

    // ── Token 用量 ────────────────────────────────────────────

    private _totalInputTokens = 0;
    private _totalOutputTokens = 0;
    private _totalTokens = 0;
    private _llmCallCount = 0;
    private _trackTokens: boolean;

    private _leadAgentTokens = 0;
    private _subagentTokens = 0;
    private _middlewareTokens = 0;

    private _tokensByModel: Record<string, {
        input_tokens: number;
        output_tokens: number;
        total_tokens: number;
        cache_read_tokens?: number;
    }> = {};

    // ── 去重 ──────────────────────────────────────────────────

    private _countedLlmRunIds = new Set<string>();
    private _countedExternalSourceIds = new Set<string>();
    private _countedMessageLlmRunIds = new Set<string>();

    // ── 便捷字段 ──────────────────────────────────────────────

    private _lastAiMsg: string | null = null;
    private _firstHumanMsg: string | null = null;
    private _msgCount = 0;
    private _hadLlmErrorFallback = false;
    private _llmErrorFallbackMessage: string | null = null;

    // ── 进度报告 ──────────────────────────────────────────────

    private _progressReporter?: ((snapshot: Record<string, unknown>) => Promise<void>) | null;
    private _progressFlushInterval: number;
    private _lastProgressFlush = 0;
    private _progressDirty = false;
    private _pendingProgressTask: ReturnType<typeof setTimeout> | null = null;
    private _pendingProgressDelayed = false;

    // ── 工具调用归因 ──────────────────────────────────────────

    private _currentRunToolCallNames: Record<string, string> = {};
    private _persistedToolMessageIdentities = new Set<string>();

    // ── Latency 追踪 ──────────────────────────────────────────

    private _llmStartTimes: Record<string, number> = {};

    // ── LLM 调用序号 ──────────────────────────────────────────

    private _llmCallIndex = 0;
    private _seenLlmStarts = new Set<string>();

    constructor(options: {
        runId: string;
        threadId: string;
        flushThreshold?: number;
        flushHandler?: (events: RunEvent[]) => Promise<void>;
        trackTokenUsage?: boolean;
        progressReporter?: ((snapshot: Record<string, unknown>) => Promise<void>) | null;
        progressFlushInterval?: number;
    }) {
        super();
        this.runId = options.runId;
        this.threadId = options.threadId;
        this._flushThreshold = options.flushThreshold ?? 20;
        this._flushHandler = options.flushHandler;
        this._trackTokens = options.trackTokenUsage ?? true;
        this._progressReporter = options.progressReporter ?? null;
        this._progressFlushInterval = options.progressFlushInterval ?? 5.0;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // LangChain 回调 — 链（Chain）生命周期
    // ════════════════════════════════════════════════════════════════════════════

    handleChainStart(
        chain: Serialized,
        inputs: ChainValues,
        runId: string,
        parentRunId?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
        runType?: string,
        runName?: string,
    ): Promise<any> | any {
        if (parentRunId !== undefined) return;
        const caller = RunJournal._identifyCaller(tags);
        const chainObj = chain as unknown as Record<string, unknown>;
        const chainName = (chainObj.name as string) ?? runName ?? "unknown";
        this._put(
            "run.start", "trace",
            { chain: chainName },
            { caller, ...(metadata ?? {}) },
        );
    }

    handleChainEnd(
        outputs: ChainValues,
        runId: string,
        parentRunId?: string,
        tags?: string[],
        kwargs?: { inputs?: Record<string, unknown> },
    ): Promise<any> | any {
        if (parentRunId !== undefined) return;
        const outputsObj = outputs as unknown as Record<string, unknown>;
        this._reconcileFinalToolMessages(outputsObj);
        this._put("run.end", "outputs", outputsObj, { status: "success" });
        this._flushSync();
    }

    handleChainError(
        err: Error,
        runId: string,
        parentRunId?: string,
        tags?: string[],
        kwargs?: { inputs?: Record<string, unknown> },
    ): Promise<any> | any {
        this._put("run.error", "error", err.message, { error_type: err.name });
        this._flushSync();
    }

    // ════════════════════════════════════════════════════════════════════════════
    // LangChain 回调 — ChatModel 生命周期
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * 捕获结构化 prompt 消息，提取第一条人类消息作为 run.input。
     */
    handleChatModelStart(
        llm: Serialized,
        messages: BaseMessage[][],
        runId: string,
        parentRunId?: string,
        extraParams?: Record<string, unknown>,
        tags?: string[],
        metadata?: Record<string, unknown>,
        runName?: string,
    ): Promise<any> | any {
        const rid = runId;
        this._llmStartTimes[rid] = Date.now();
        this._llmCallIndex++;
        this._seenLlmStarts.add(rid);

        const caller = RunJournal._identifyCaller(tags);

        // 捕获 lead_agent 的第一条人类消息
        if (caller === "lead_agent" && !this._firstHumanMsg && messages.length > 0) {
            for (let bi = messages.length - 1; bi >= 0; bi--) {
                const batch = messages[bi];
                for (let mi = batch.length - 1; mi >= 0; mi--) {
                    const m = batch[mi];
                    if (!RunJournal._shouldPersistHumanInputMessage(m)) continue;
                    const text = RunJournal._messageText(m);
                    this.setFirstHumanMessage(text);
                    this._put("llm.human.input", "message", m.toJSON(), { caller });
                    this._recordMessageSummary(m, caller);
                    break;
                }
                if (this._firstHumanMsg) break;
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // LangChain 回调 — LLM 生命周期（非 Chat 模型的后备）
    // ════════════════════════════════════════════════════════════════════════════

    handleLLMStart(
        llm: Serialized,
        prompts: string[],
        runId: string,
        parentRunId?: string,
        extraParams?: Record<string, unknown>,
        tags?: string[],
        metadata?: Record<string, unknown>,
        runName?: string,
    ): Promise<any> | any {
        this._llmStartTimes[runId] = Date.now();
    }

    /**
     * 处理 LLM 响应：提取消息、计算耗时、累加 token、记录事件。
     */
    handleLLMEnd(
        output: LLMResult,
        runId: string,
        parentRunId?: string,
        tags?: string[],
        extraParams?: Record<string, unknown>,
    ): Promise<any> | any {
        const messages: BaseMessage[] = [];
        for (const generation of output.generations) {
            for (const gen of generation) {
                const chatGen = gen as ChatGeneration;
                if (chatGen.message) {
                    messages.push(chatGen.message);
                }
            }
        }

        for (const message of messages) {
            const caller = RunJournal._identifyCaller(tags);
            this._rememberCurrentRunToolCalls(message, caller);

            // Latency
            const rid = runId;
            const start = this._llmStartTimes[rid];
            const latencyMs = start ? Date.now() - start : undefined;
            delete this._llmStartTimes[rid];

            // Token usage
            const msgAny = message as unknown as Record<string, unknown>;
            const usage = msgAny.usage_metadata as Record<string, unknown> | undefined;
            const usageDict: Record<string, unknown> = usage ?? {};
            const additionalKwargs = message.additional_kwargs ?? {};

            if (additionalKwargs.deerflow_error_fallback) {
                this._hadLlmErrorFallback = true;
                const detail = additionalKwargs.error_detail as string | undefined;
                const reason = additionalKwargs.error_reason as string | undefined;
                const fallbackText = RunJournal._messageText(message).trim();
                if (detail?.trim()) this._llmErrorFallbackMessage = detail.trim().slice(0, 2000);
                else if (reason?.trim()) this._llmErrorFallbackMessage = reason.trim().slice(0, 2000);
                else if (fallbackText) this._llmErrorFallbackMessage = fallbackText.slice(0, 2000);
            }

            // Resolve call index
            let callIndex: number;
            if (this._seenLlmStarts.has(rid)) {
                callIndex = this._llmCallIndex;
            } else {
                this._llmCallIndex++;
                callIndex = this._llmCallIndex;
                this._seenLlmStarts.add(rid);
            }

            // Trace event: llm_response
            this._put("llm.ai.response", "message", message.toJSON(), {
                caller,
                usage: usageDict,
                latency_ms: latencyMs ?? null,
                llm_call_index: callIndex,
            });

            if (!this._countedMessageLlmRunIds.has(rid)) {
                this._recordMessageSummary(message, caller);
            }

            // Token accumulation (dedup by run_id)
            if (this._trackTokens) {
                const inputTk = (usageDict.input_tokens as number) ?? 0;
                const outputTk = (usageDict.output_tokens as number) ?? 0;
                let totalTk = (usageDict.total_tokens as number) ?? 0;
                if (totalTk === 0) totalTk = inputTk + outputTk;

                if (totalTk > 0 && !this._countedLlmRunIds.has(rid)) {
                    this._countedLlmRunIds.add(rid);
                    this._totalInputTokens += inputTk;
                    this._totalOutputTokens += outputTk;
                    this._totalTokens += totalTk;
                    this._llmCallCount++;

                    if (caller.startsWith("subagent:")) this._subagentTokens += totalTk;
                    else if (caller.startsWith("middleware:")) this._middlewareTokens += totalTk;
                    else this._leadAgentTokens += totalTk;

                    const responseMetadata = message.response_metadata ?? {};
                    const perCallModel = (responseMetadata as Record<string, unknown>).model_name ?? (responseMetadata as Record<string, unknown>).model;
                    const cacheRead = RunJournal._extractCacheRead(usageDict);
                    this._recordModelUsage(perCallModel as string | undefined, inputTk, outputTk, totalTk, cacheRead);

                    this._scheduleProgressFlush();
                }
            }
        }

        if (messages.length > 0) {
            this._countedMessageLlmRunIds.add(runId);
        }
    }

    handleLLMError(
        err: Error,
        runId: string,
        parentRunId?: string,
        tags?: string[],
        extraParams?: Record<string, unknown>,
    ): Promise<any> | any {
        delete this._llmStartTimes[runId];
        this._put("llm.error", "trace", err.message);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // LangChain 回调 — 工具（Tool）生命周期
    // ════════════════════════════════════════════════════════════════════════════

    handleToolStart(
        tool: Serialized,
        input: string,
        runId: string,
        parentRunId?: string,
        tags?: string[],
        metadata?: Record<string, unknown>,
        runName?: string,
    ): Promise<any> | any {
        // 对应 Python on_tool_start —— 缓存 tool_call_id 作后续关联
    }

    handleToolEnd(
        output: any,
        runId: string,
        parentRunId?: string,
        tags?: string[],
    ): Promise<any> | any {
        try {
            if (output && typeof output === "object" && (output as ToolMessage).tool_call_id !== undefined) {
                this._persistToolResultMessage(output as BaseMessage);
            } else if (output?.constructor?.name === "Command") {
                const updates = (output as Record<string, unknown>).update as Record<string, unknown> | undefined;
                if (updates) {
                    const msgs = updates.messages;
                    if (Array.isArray(msgs)) {
                        for (const message of msgs) {
                            if (message && typeof (message as unknown as Record<string, unknown>).type === "string") {
                                this._persistToolResultMessage(message as BaseMessage);
                            }
                        }
                    }
                }
            }
        } finally {
            // 清理
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部：事件记录
    // ════════════════════════════════════════════════════════════════════════════

    private _put(
        eventType: string,
        category: string,
        content: unknown,
        metadata?: Record<string, unknown>,
    ): void {
        this._buffer.push({
            thread_id: this.threadId,
            run_id: this.runId,
            event_type: eventType,
            category,
            content: content ?? "",
            metadata: metadata ?? {},
            created_at: new Date().toISOString(),
        });
        if (this._buffer.length >= this._flushThreshold) {
            this._flushSync();
        }
    }

    /** 公开的事件记录入口，供外部手动写入事件。 */
    put(event: Omit<RunEvent, "thread_id" | "run_id" | "created_at">): void {
        this._put(event.event_type, event.category, event.content, event.metadata);
    }

    // ── flush ─────────────────────────────────────────────────

    private _flushSync(): void {
        if (!this._flushHandler || this._buffer.length === 0) return;
        if (this._pendingFlushTasks.size > 0) return;

        const batch = this._buffer.splice(0);
        const task = this._flushAsync(batch);
        this._pendingFlushTasks.add(task);
        task.finally(() => this._pendingFlushTasks.delete(task)).catch(() => {});
    }

    private async _flushAsync(batch: RunEvent[]): Promise<void> {
        try {
            await this._flushHandler!(batch);
        } catch {
            this._buffer = [...batch, ...this._buffer];
        }
    }

    async flush(): Promise<void> {
        if (this._pendingFlushTasks.size > 0) {
            await Promise.allSettled([...this._pendingFlushTasks]);
        }

        if (this._pendingProgressTask !== null) {
            if (this._pendingProgressDelayed) {
                clearTimeout(this._pendingProgressTask);
                this._pendingProgressTask = null;
                this._progressDirty = false;
                this._pendingProgressDelayed = false;
            } else {
                const task = this._pendingProgressTask;
                this._pendingProgressTask = null;
                await task;
            }
        }

        while (this._buffer.length > 0) {
            const batch = this._buffer.splice(0, this._flushThreshold);
            if (this._flushHandler) {
                try {
                    await this._flushHandler(batch);
                } catch (e) {
                    this._buffer = [...batch, ...this._buffer];
                    throw e;
                }
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部：调用方识别
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * 从 tags 中识别调用方身份。
     * 主 Agent 图本身不注入 tags，默认返回 "lead_agent"。
     */
    private static _identifyCaller(tags?: string[] | null): string {
        if (!tags) return "lead_agent";
        for (const tag of tags) {
            if (tag.startsWith("subagent:") || tag.startsWith("middleware:") || tag === "lead_agent") {
                return tag;
            }
        }
        return "lead_agent";
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部：消息工具
    // ════════════════════════════════════════════════════════════════════════════

    /** 从 BaseMessage 中提取可显示的文本。 */
    private static _messageText(message: BaseMessage): string {
        const content = message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const texts: string[] = [];
            for (const part of content) {
                if (typeof part === "object" && part !== null && "text" in part) {
                    const text = (part as { text: string }).text;
                    if (text) texts.push(text);
                }
            }
            if (texts.length > 0) return texts.join("");
        }
        const msgAny = message as unknown as Record<string, unknown>;
        const text = msgAny.text as string | undefined;
        if (text) return text;
        return "";
    }

    /** 检查是否应该持久化一条 HumanMessage。 */
    private static _shouldPersistHumanInputMessage(message: BaseMessage): boolean {
        const msgAny = message as unknown as Record<string, unknown>;
        if (msgAny.type !== "human") return false;
        if (message.name === _LEGACY_SUMMARY_MESSAGE_NAME) return false;
        const kwargs = message.additional_kwargs ?? {};
        if (kwargs.hide_from_ui !== true) return true;
        const response = kwargs.human_input_response as Record<string, unknown> | undefined;
        return response !== null && response !== undefined &&
            typeof response.source === "string" &&
            _PERSISTED_HIDDEN_HUMAN_INPUT_RESPONSE_SOURCES.has(response.source);
    }

    /** 从 usage dict 提取 cache_read token。 */
    private static _extractCacheRead(usageDict: Record<string, unknown>): number {
        const details = usageDict.input_token_details as Record<string, unknown> | undefined;
        if (!details) return 0;
        try {
            const val = Number(details.cache_read);
            return Number.isFinite(val) && val > 0 ? val : 0;
        } catch {
            return 0;
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部：Token 累计
    // ════════════════════════════════════════════════════════════════════════════

    private _recordModelUsage(
        name: string | undefined,
        input: number,
        output: number,
        total: number,
        cacheRead: number,
    ): void {
        const bucket = this._tokensByModel[name ?? "unknown"] ??= {
            input_tokens: 0, output_tokens: 0, total_tokens: 0,
        };
        bucket.input_tokens += input;
        bucket.output_tokens += output;
        bucket.total_tokens += total;
        if (cacheRead > 0) {
            bucket.cache_read_tokens = (bucket.cache_read_tokens ?? 0) + cacheRead;
        }
    }

    /** 记录外部来源的 token 用量（如子代理的汇总数据）。 */
    recordExternalUsage(records: Array<Record<string, unknown>>): void {
        if (!this._trackTokens) return;
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
            this._recordModelUsage(
                record.model_name as string | undefined,
                inputTk, outputTk, totalTk, cacheRead,
            );
            this._scheduleProgressFlush();
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部：工具调用归因
    // ════════════════════════════════════════════════════════════════════════════

    private _rememberCurrentRunToolCalls(message: BaseMessage, caller: string): void {
        if (caller !== "lead_agent") return;
        const msgAny = message as unknown as Record<string, unknown>;
        if (msgAny.type !== "ai") return;
        const toolCalls = msgAny.tool_calls as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(toolCalls)) return;
        for (const tc of toolCalls) {
            const id = tc.id;
            const name = tc.name;
            if (typeof id === "string" && id && typeof name === "string") {
                this._currentRunToolCallNames[id] = name;
            }
        }
    }

    private _persistToolResultMessage(message: BaseMessage): void {
        this._put("llm.tool.result", "message", message.toJSON());
        const identity = this._messageIdentity(message);
        if (identity) this._persistedToolMessageIdentities.add(identity);
        this._recordMessageSummary(message);
    }

    private _messageIdentity(message: BaseMessage): string | null {
        const toolMsg = message as ToolMessage;
        if (toolMsg.tool_call_id) return `tool:${toolMsg.tool_call_id}`;
        const msgAny = message as unknown as Record<string, unknown>;
        const msgId = msgAny.id as string | undefined;
        if (typeof msgId === "string" && msgId) return `message:${msgId}`;
        return null;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部：工具消息 Reconcile
    // ════════════════════════════════════════════════════════════════════════════

    private _reconcileFinalToolMessages(outputs: Record<string, unknown>): void {
        const messages = this._finalOutputMessages(outputs);
        for (const message of messages) {
            if ((message as unknown as Record<string, unknown>).type !== "tool") continue;
            if (this._shouldReconcileToolMessage(message as ToolMessage)) {
                this._persistToolResultMessage(message as BaseMessage);
            }
        }
    }

    private _finalOutputMessages(outputs: Record<string, unknown>): unknown[] {
        const messages = outputs.messages;
        return Array.isArray(messages) ? messages : [];
    }

    private _shouldReconcileToolMessage(message: ToolMessage): boolean {
        const kwargs = message.additional_kwargs ?? {};
        if (kwargs.hide_from_ui === true) return false;

        const toolCallId = message.tool_call_id;
        if (!toolCallId) return false;

        const toolCallName = this._currentRunToolCallNames[toolCallId];
        if (!toolCallName) return false;

        const messageName = message.name ?? "";
        if (!_RECONCILED_TOOL_MESSAGE_NAMES.has(messageName) &&
            !_RECONCILED_TOOL_MESSAGE_NAMES.has(toolCallName)) {
            return false;
        }

        const identity = this._messageIdentity(message);
        return identity !== null && !this._persistedToolMessageIdentities.has(identity);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部：消息摘要
    // ════════════════════════════════════════════════════════════════════════════

    private _recordMessageSummary(message: BaseMessage, caller?: string): void {
        this._msgCount++;
        const msgAny = message as unknown as Record<string, unknown>;
        const isAi = msgAny.type === "ai";
        if (isAi && (caller === undefined || caller === "lead_agent")) {
            const text = RunJournal._messageText(message).trim();
            if (text) this._lastAiMsg = text.slice(0, 2000);
        }
    }

    setFirstHumanMessage(content: string): void {
        this._firstHumanMsg = content.slice(0, 2000) || null;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 公开方法
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * 记录中间件状态变更事件。
     * 调用方：中间件实现中执行有意义的状态变更时调用（如 title 生成、summarization）。
     * 纯观察型中间件不应调用此方法。
     */
    recordMiddleware(
        tag: string,
        name: string,
        hook: string,
        action: string,
        changes: Record<string, unknown>,
    ): void {
        this._put(`middleware:${tag}`, "middleware", { name, hook, action, changes });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 进度报告
    // ════════════════════════════════════════════════════════════════════════════

    private _scheduleProgressFlush(): void {
        if (!this._progressReporter) return;
        const now = Date.now();
        const elapsed = now - this._lastProgressFlush;
        const intervalMs = this._progressFlushInterval * 1000;

        if (elapsed < intervalMs) {
            this._progressDirty = true;
            if (this._pendingProgressTask === null) {
                this._scheduleDelayedProgressFlush(intervalMs - elapsed);
            }
            return;
        }

        if (this._pendingProgressTask !== null) {
            this._progressDirty = true;
            return;
        }

        this._progressDirty = false;
        this._pendingProgressTask = setTimeout(() => {
            this._pendingProgressTask = null;
            this._flushProgress();
        }, 0);
    }

    private _scheduleDelayedProgressFlush(delay: number): void {
        if (this._pendingProgressTask !== null && !this._pendingProgressDelayed) return;
        this._pendingProgressDelayed = delay > 0;
        this._pendingProgressTask = setTimeout(() => {
            this._pendingProgressDelayed = false;
            this._pendingProgressTask = null;
            this._flushProgress();
        }, delay);
    }

    private async _flushProgress(): Promise<void> {
        if (!this._progressReporter) return;
        const dirtyBeforeWrite = this._progressDirty;
        this._progressDirty = false;
        try {
            await this._progressReporter(this.getCompletionData());
            this._lastProgressFlush = Date.now();
        } catch {
            // 忽略失败
        }
        if (dirtyBeforeWrite || this._progressDirty) {
            this._progressDirty = false;
            this._pendingProgressTask = null;
            this._scheduleDelayedProgressFlush(this._progressFlushInterval * 1000);
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 完成数据
    // ════════════════════════════════════════════════════════════════════════════

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
