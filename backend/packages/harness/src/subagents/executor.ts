/**
 * 子代理执行引擎。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/executor.py
 *
 * 负责创建和运行子 Agent 实例，管理生命周期和结果收集。
 * Agent 创建委托给外部回调（由 Layer 10 Agent 工厂提供）。
 */

import { type SubagentConfig, resolveSubagentModelName } from "./config.js";
import { captureNewStepMessages } from "./step_events.js";
import { SubagentTokenCollector } from "./token_collector.js";

// ════════════════════════════════════════════════════════════════════════════════
// 状态枚举
// ════════════════════════════════════════════════════════════════════════════════

export enum SubagentStatus {
    PENDING = "pending",
    RUNNING = "running",
    COMPLETED = "completed",
    FAILED = "failed",
    CANCELLED = "cancelled",
    TIMED_OUT = "timed_out",
}

const _TERMINAL_STATUSES = new Set([
    SubagentStatus.COMPLETED,
    SubagentStatus.FAILED,
    SubagentStatus.CANCELLED,
    SubagentStatus.TIMED_OUT,
]);

export function isTerminalStatus(status: SubagentStatus): boolean {
    return _TERMINAL_STATUSES.has(status);
}

// ════════════════════════════════════════════════════════════════════════════════
// 结果类型
// ════════════════════════════════════════════════════════════════════════════════

export interface SubagentResult {
    task_id: string;
    trace_id: string;
    status: SubagentStatus;
    result?: string | null;
    error?: string | null;
    stop_reason?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    ai_messages: Array<Record<string, unknown>>;
    token_usage_records: Array<Record<string, unknown>>;
    usage_reported: boolean;
    cancelled: boolean;
}

export function createPendingResult(taskId: string, traceId: string): SubagentResult {
    return {
        task_id: taskId,
        trace_id: traceId,
        status: SubagentStatus.PENDING,
        ai_messages: [],
        token_usage_records: [],
        usage_reported: false,
        cancelled: false,
    };
}

export function trySetTerminal(
    result: SubagentResult,
    status: SubagentStatus,
    options?: {
        result?: string | null;
        error?: string | null;
        stop_reason?: string | null;
        ai_messages?: Array<Record<string, unknown>>;
        token_usage_records?: Array<Record<string, unknown>>;
    },
): boolean {
    if (!isTerminalStatus(status)) throw new Error(`Status ${status} is not terminal`);
    if (isTerminalStatus(result.status)) return false;

    result.status = status;
    result.completed_at = new Date().toISOString();
    if (options?.result !== undefined) result.result = options.result;
    if (options?.error !== undefined) result.error = options.error;
    if (options?.stop_reason !== undefined) result.stop_reason = options.stop_reason;
    if (options?.ai_messages !== undefined) result.ai_messages = options.ai_messages;
    if (options?.token_usage_records !== undefined) result.token_usage_records = options.token_usage_records;
    return true;
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具过滤
// ════════════════════════════════════════════════════════════════════════════════

export function filterTools(
    allTools: Array<{ name: string; [key: string]: unknown }>,
    allowed: string[] | null,
    disallowed: string[] | null,
): Array<{ name: string; [key: string]: unknown }> {
    let filtered = allTools;
    if (allowed !== null) {
        const allowedSet = new Set(allowed);
        filtered = filtered.filter((t) => allowedSet.has(t.name));
    }
    if (disallowed !== null) {
        const disallowedSet = new Set(disallowed);
        filtered = filtered.filter((t) => !disallowedSet.has(t.name));
    }
    return filtered;
}

// ════════════════════════════════════════════════════════════════════════════════
// Agent 创建回调类型
// ════════════════════════════════════════════════════════════════════════════════

export interface AgentInstance {
    stream(
        state: Record<string, unknown>,
        options?: Record<string, unknown>,
    ): AsyncIterable<Record<string, unknown>>;
}

export type AgentFactory = (
    tools: Array<{ name: string; [key: string]: unknown }>,
    config: SubagentConfig,
    modelName: string,
) => AgentInstance;

// ════════════════════════════════════════════════════════════════════════════════
// 最终结果提取
// ════════════════════════════════════════════════════════════════════════════════

function _extractFinalResult(
    finalState: Record<string, unknown> | null,
    _traceId: string,
    _name: string,
): string {
    if (!finalState) return "No response generated";
    const messages = (finalState.messages as Array<Record<string, unknown>>) ?? [];
    if (messages.length === 0) return "No response generated";

    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === "ai") {
            const content = String(messages[i].content ?? "");
            return content.trim() || "No response generated";
        }
    }

    const last = messages[messages.length - 1];
    const content = String(last.content ?? "");
    return content.trim() || "No response generated";
}

// ════════════════════════════════════════════════════════════════════════════════
// 全局后台任务存储
// ════════════════════════════════════════════════════════════════════════════════

const _backgroundTasks = new Map<string, SubagentResult>();
const MAX_CONCURRENT_SUBAGENTS = 3;

export function getBackgroundTaskResult(taskId: string): SubagentResult | null {
    return _backgroundTasks.get(taskId) ?? null;
}

export function listBackgroundTasks(): SubagentResult[] {
    return Array.from(_backgroundTasks.values());
}

export function requestCancelBackgroundTask(taskId: string): void {
    const result = _backgroundTasks.get(taskId);
    if (result) result.cancelled = true;
}

export function cleanupBackgroundTask(taskId: string): void {
    const result = _backgroundTasks.get(taskId);
    if (result && (isTerminalStatus(result.status) || result.completed_at)) {
        _backgroundTasks.delete(taskId);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 子代理执行器
// ════════════════════════════════════════════════════════════════════════════════

export class SubagentExecutor {
    public readonly config: SubagentConfig;
    public readonly traceId: string;
    public readonly appConfig?: unknown;
    public readonly parentModel?: string | null;
    public readonly modelName?: string | null;

    private _baseTools: Array<{ name: string; [key: string]: unknown }>;
    private _agentFactory?: AgentFactory | null;

    constructor(options: {
        config: SubagentConfig;
        tools: Array<{ name: string; [key: string]: unknown }>;
        appConfig?: unknown;
        parentModel?: string | null;
        threadId?: string | null;
        traceId?: string;
        userId?: string | null;
        agentFactory?: AgentFactory | null;
    }) {
        const { config, tools, appConfig, parentModel, traceId, agentFactory } = options;
        this.config = config;
        this.appConfig = appConfig;
        this.parentModel = parentModel ?? null;
        this.traceId = traceId ?? `sub-${Math.random().toString(36).slice(2, 10)}`;
        this._agentFactory = agentFactory ?? null;

        if (config.model !== "inherit" || parentModel !== null || appConfig !== undefined) {
            this.modelName = resolveSubagentModelName(config, parentModel, appConfig as never);
        }

        this._baseTools = filterTools(tools, config.tools, config.disallowed_tools);
    }

    // ── 初始状态构建 ─────────────────────────────────────────────

    private async _buildInitialState(task: string): Promise<Record<string, unknown>> {
        const messages: Array<Record<string, unknown>> = [];
        if (this.config.system_prompt) {
            messages.push({ type: "system", content: this.config.system_prompt });
        }
        messages.push({ type: "human", content: task });

        const state: Record<string, unknown> = { messages };
        return state;
    }

    // ── 主执行逻辑 ───────────────────────────────────────────────

    async _aexecute(
        task: string,
        result?: SubagentResult,
    ): Promise<SubagentResult> {
        if (!result) {
            const taskId = Math.random().toString(36).slice(2, 10);
            result = createPendingResult(taskId, this.traceId);
        }
        result.status = SubagentStatus.RUNNING;
        result.started_at = new Date().toISOString();

        const collector = new SubagentTokenCollector(`subagent:${this.config.name}`);
        const aiMessages = result.ai_messages;
        const seenMessageIds = new Set<string>(
            aiMessages.map((m) => String(m.id ?? "")).filter(Boolean),
        );
        let processedMessageCount = 0;

        try {
            const state = await this._buildInitialState(task);

            if (!this._agentFactory) {
                // 没有 Agent 工厂：模拟执行
                trySetTerminal(result, SubagentStatus.COMPLETED, {
                    result: `Subagent '${this.config.name}' executed task (placeholder)`,
                    token_usage_records: (collector.snapshotRecords() as unknown as Array<Record<string, unknown>>),
                });
                return result;
            }

            const agent = this._agentFactory(this._baseTools, this.config, this.modelName ?? "");
            const runConfig: Record<string, unknown> = {
                recursion_limit: this.config.max_turns,
                tags: [`subagent:${this.config.name}`],
            };

            // 流式执行
            let finalState: Record<string, unknown> | null = null;

            if (result.cancelled) {
                trySetTerminal(result, SubagentStatus.CANCELLED, {
                    error: "Cancelled by user",
                    token_usage_records: (collector.snapshotRecords() as unknown as Array<Record<string, unknown>>),
                });
                return result;
            }

            // 使用 Symbol.asyncIterator 模式
            const stream = agent.stream(state, runConfig);
            for await (const chunk of stream) {
                if (result.cancelled) {
                    trySetTerminal(result, SubagentStatus.CANCELLED, {
                        error: "Cancelled by user",
                        token_usage_records: (collector.snapshotRecords() as unknown as Array<Record<string, unknown>>),
                    });
                    return result;
                }

                finalState = chunk;
                const chunkMessages = (chunk.messages as Array<Record<string, unknown>>) ?? [];
                processedMessageCount = captureNewStepMessages(
                    chunkMessages,
                    aiMessages,
                    seenMessageIds,
                    processedMessageCount,
                );
            }

            const tokenRecords = (collector.snapshotRecords() as unknown as Array<Record<string, unknown>>);
            const finalResult = _extractFinalResult(finalState, this.traceId, this.config.name);
            trySetTerminal(result, SubagentStatus.COMPLETED, {
                result: finalResult,
                token_usage_records: tokenRecords,
            });
        } catch (error) {
            trySetTerminal(result, SubagentStatus.FAILED, {
                error: (error as Error).message,
                token_usage_records: (collector.snapshotRecords() as unknown as Array<Record<string, unknown>>),
            });
        }

        return result;
    }

    // ── 同步执行 ─────────────────────────────────────────────────

    execute(task: string, result?: SubagentResult): SubagentResult {
        throw new Error("Sync execution not implemented. Use executeAsync for background execution.");
    }

    // ── 后台执行 ─────────────────────────────────────────────────

    executeAsync(task: string, taskId?: string): string {
        const tid = taskId ?? Math.random().toString(36).slice(2, 10);

        const result = createPendingResult(tid, this.traceId);
        _backgroundTasks.set(tid, result);

        // 异步执行（在 JS 事件循环中跑）
        this._aexecute(task, result).then((finalResult) => {
            _backgroundTasks.set(tid, finalResult);
        }).catch((error) => {
            if (_backgroundTasks.has(tid)) {
                const r = _backgroundTasks.get(tid)!;
                trySetTerminal(r, SubagentStatus.FAILED, {
                    error: String(error),
                });
            }
        });

        return tid;
    }
}
