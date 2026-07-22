/**
 * 子代理 Token 用量收集器。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/token_collector.py
 *
 * 每个子代理执行时创建一个收集器。
 * 子代理结束后，收集的记录通过 RunJournal.recordExternalLlmUsage 传给父级。
 *
 * 原项目是 LangChain BaseCallbackHandler，通过回调自动接收 LLM 的 token 用量。
 * TS 版本没有回调系统，改成手动接收记录的方式——模型提供者调用 reportUsage 来提交。
 */

export interface TokenUsageRecord {
    source_run_id: string;
    caller: string;
    model_name: string | null;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens?: number;
}

/**
 * 轻量级子代理 Token 用量收集器。
 *
 * 使用方式：
 *   1. 子代理启动时创建 new SubagentTokenCollector("agent_name")
 *   2. 每次 LLM 调用完成后，调用 reportUsage() 提交用量
 *   3. 子代理结束后，调用 snapshotRecords() 取出记录
 */
export class SubagentTokenCollector {
    public readonly caller: string;
    private _records: TokenUsageRecord[] = [];
    private _countedRunIds: Set<string> = new Set();

    constructor(caller: string) {
        this.caller = caller;
    }

    /**
     * 报告一次 LLM 调用的 token 用量。
     *
     * @param runId 运行 ID（用于去重）
     * @param usage token 用量
     * @param modelName 实际使用的模型名
     */
    reportUsage(
        runId: string,
        usage: {
            input_tokens: number;
            output_tokens: number;
            total_tokens?: number;
            cache_read_tokens?: number;
        },
        modelName?: string | null,
    ): void {
        if (this._countedRunIds.has(runId)) return;

        let inputTk = Math.max(0, usage.input_tokens || 0);
        let outputTk = Math.max(0, usage.output_tokens || 0);
        let totalTk = Math.max(0, usage.total_tokens || 0);
        if (totalTk <= 0) totalTk = inputTk + outputTk;
        if (totalTk <= 0) return;

        const cacheReadTk = Math.max(0, usage.cache_read_tokens || 0);

        this._countedRunIds.add(runId);
        const record: TokenUsageRecord = {
            source_run_id: runId,
            caller: this.caller,
            model_name: modelName ?? null,
            input_tokens: inputTk,
            output_tokens: outputTk,
            total_tokens: totalTk,
        };
        // 只有有缓存命中的时候才加这个字段（稀疏存储）
        if (cacheReadTk > 0) {
            record.cache_read_tokens = cacheReadTk;
        }
        this._records.push(record);
    }

    /**
     * 返回累积的用量记录的副本。
     */
    snapshotRecords(): TokenUsageRecord[] {
        return [...this._records];
    }
}
