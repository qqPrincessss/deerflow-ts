/**
 * 子代理执行引擎。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/executor.py
 *
 * 负责创建和运行子 Agent 实例，管理生命周期和结果收集。
 *
 * 当前状态：骨架实现。
 * 依赖 Layer 8（中间件）、Layer 9（技能、MCP、链路追踪）完成后接入完整逻辑。
 */

import { type SubagentConfig, resolveSubagentModelName } from "./config.js";
import { type SubagentStatusValue } from "./status_contract.js";
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

export const TERMINAL_STATUSES = new Set([
    SubagentStatus.COMPLETED,
    SubagentStatus.FAILED,
    SubagentStatus.CANCELLED,
    SubagentStatus.TIMED_OUT,
]);

export function isTerminalStatus(status: SubagentStatus): boolean {
    return TERMINAL_STATUSES.has(status);
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
    token_usage_records: TokenUsageRecord[];
    usage_reported: boolean;
    cancelled: boolean;
}

interface TokenUsageRecord {
    source_run_id: string;
    caller: string;
    model_name: string | null;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens?: number;
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

/**
 * 尝试设置终端状态（幂等）。
 * 当状态已经是 terminal 时返回 false。
 */
export function trySetTerminal(
    result: SubagentResult,
    status: SubagentStatus,
    options?: {
        result?: string | null;
        error?: string | null;
        stop_reason?: string | null;
        ai_messages?: Array<Record<string, unknown>>;
        token_usage_records?: TokenUsageRecord[];
    },
): boolean {
    if (!isTerminalStatus(status)) {
        throw new Error(`Status ${status} is not terminal`);
    }
    if (isTerminalStatus(result.status)) {
        return false; // 已经 terminal，不覆盖
    }

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

/**
 * 根据子代理配置过滤工具。
 * 先应用白名单（如果有），再应用黑名单。
 */
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
// 最终结果提取
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从子代理最终状态中提取人类可读的结果文本。
 */
function _extractFinalResult(
    finalState: Record<string, unknown> | null,
    traceId: string,
    name: string,
): string {
    if (finalState === null) {
        return "No response generated";
    }

    const messages = (finalState.messages as Array<Record<string, unknown>>) ?? [];
    if (messages.length === 0) {
        return "No response generated";
    }

    // 找最后一条 AIMessage
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === "ai") {
            const content = (msg.content as string) ?? "";
            return content.trim() || "No response generated";
        }
    }

    // 没有 AIMessage，用最后一条消息
    const lastMsg = messages[messages.length - 1];
    const content = (lastMsg.content as string) ?? "";
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
    if (result) {
        result.cancelled = true;
    }
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

    /** 经过白名单/黑名单过滤后的基础工具集 */
    private _baseTools: Array<{ name: string; [key: string]: unknown }>;

    constructor(options: {
        config: SubagentConfig;
        tools: Array<{ name: string; [key: string]: unknown }>;
        appConfig?: unknown;
        parentModel?: string | null;
        threadId?: string | null;
        traceId?: string;
        userId?: string | null;
    }) {
        const { config, tools, appConfig, parentModel, traceId } = options;
        this.config = config;
        this.appConfig = appConfig;
        this.parentModel = parentModel ?? null;
        this.traceId = traceId ?? `sub-${Math.random().toString(36).slice(2, 10)}`;

        // 提前解析 model name 当不依赖 config 时
        if (config.model !== "inherit" || parentModel !== null || appConfig !== undefined) {
            this.modelName = resolveSubagentModelName(config, parentModel, appConfig as never);
        }

        this._baseTools = filterTools(tools, config.tools, config.disallowed_tools);
    }

    /**
     * 创建 Agent 实例（待接入 Layer 8 中间件后完成）。
     *
     * TODO:
     * - 调用模型工厂 createChatModel
     * - 接入子代理中间件链（tool_error_handling, token_budget, loop_detection 等）
     * - 启用延迟工具提升（tool_search）
     */
    private _createAgent(): void {
        // const appConfig = this.appConfig ?? getAppConfig();
        // const model = createChatModel(this.modelName!, { thinking_enabled: false });
        // return createAgent({ model, tools: this._baseTools, ... });
        throw new Error("Subagent agent creation not yet implemented - requires Layer 8 middlewares");
    }

    /**
     * 构建初始状态。
     *
     * TODO:
     * - 加载技能（需 skills/storage + skills/tool_policy）
     * - 注入延迟工具提示（需 tool_search）
     * - 传递父代理的沙箱/线程数据
     */
    private async _buildInitialState(task: string): Promise<Record<string, unknown>> {
        const messages: Array<Record<string, unknown>> = [];

        if (this.config.system_prompt) {
            messages.push({ type: "system", content: this.config.system_prompt });
        }

        messages.push({ type: "human", content: task });

        return { messages };
    }

    /**
     * 异步执行子代理任务。
     */
    async _aexecute(
        task: string,
        result?: SubagentResult,
    ): Promise<SubagentResult> {
        if (!result) {
            const taskId = Math.random().toString(36).slice(2, 10);
            result = createPendingResult(taskId, this.traceId);
            result.status = SubagentStatus.RUNNING;
            result.started_at = new Date().toISOString();
        }

        result.status = SubagentStatus.RUNNING;
        result.started_at = new Date().toISOString();

        const collector = new SubagentTokenCollector(`subagent:${this.config.name}`);
        const aiMessages = result.ai_messages;
        const seenMessageIds = new Set<string>();
        let processedMessageCount = 0;

        try {
            const state = await this._buildInitialState(task);
            // const agent = this._createAgent();
            // await agent.stream(state, ...);
            //
            // TODO: 接入 astream 循环，实时捕获消息

            // 占位：模拟执行
            const finalResult = `Subagent '${this.config.name}' executed task successfully (placeholder)`;
            trySetTerminal(result, SubagentStatus.COMPLETED, {
                result: finalResult,
                token_usage_records: collector.snapshotRecords(),
            });
        } catch (error) {
            trySetTerminal(result, SubagentStatus.FAILED, {
                error: (error as Error).message,
                token_usage_records: collector.snapshotRecords(),
            });
        }

        return result;
    }

    /**
     * 同步执行子代理（在当前线程阻塞）。
     */
    execute(task: string, result?: SubagentResult): SubagentResult {
        // TODO: 将来需要处理已在运行的事件循环的情况（isolated loop）
        // 现在简单用 Promise.resolve 模拟
        throw new Error("Sync execution not yet implemented - use executeAsync for background execution");
    }

    /**
     * 在后台启动子代理任务。
     * 返回 taskId，调用方轮询 getBackgroundTaskResult() 获取结果。
     */
    executeAsync(task: string, taskId?: string): string {
        const tid = taskId ?? Math.random().toString(36).slice(2, 10);

        const result = createPendingResult(tid, this.traceId);
        _backgroundTasks.set(tid, result);

        // 异步执行
        this._aexecute(task, result).then((finalResult) => {
            _backgroundTasks.set(tid, finalResult);
        }).catch((error) => {
            if (_backgroundTasks.has(tid)) {
                const r = _backgroundTasks.get(tid)!;
                trySetTerminal(r, SubagentStatus.FAILED, {
                    error: (error as Error).message,
                });
            }
        });

        return tid;
    }
}
