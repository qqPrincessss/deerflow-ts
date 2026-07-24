/**
 * DeerFlowClient — 嵌入式 DeerFlow Agent 系统客户端。
 *
 * 对应原项目：backend/packages/harness/deerflow/client.py
 *
 * 提供对 DeerFlow Agent 能力的直接编程访问，
 * 无需 LangGraph Server 或 Gateway API 进程。
 *
 * 用法：
 *   const client = new DeerFlowClient();
 *   const response = await client.chat("分析这篇论文", { threadId: "my-thread" });
 *   console.log(response);
 *
 *   流式：
 *   for await (const event of client.stream("你好")) {
 *       console.log(event);
 *   }
 */

import { createHash } from "node:crypto";
import { getAppConfig, getModelConfig, invalidateConfigCache } from "./config/app_config.js";
import { createChatModel } from "./models/factory.js";
import { type GoalState, type GoalEvaluation, type GoalBlocker } from "./agents/goal_state.js";
import {
    buildGoalState,
    goalThreadLock,
    readThreadGoal,
    writeThreadGoal,
    DEFAULT_MAX_GOAL_CONTINUATIONS,
    type GoalCommandKind,
} from "./runtime/goal.js";
import { getEffectiveUserId } from "./runtime/user_context.js";
import { type AppConfig } from "./config/app_config.js";
import type { Message, ToolCall, RuntimeContext, AgentInstance } from "./agents/factory.js";
import { makeLeadAgent, buildMiddlewares } from "./agents/lead_agent/agent.js";
import { applyPromptTemplate, getSkillsPromptSection } from "./agents/lead_agent/prompt.js";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export type StreamEventType = "values" | "messages-tuple" | "custom" | "end";

export interface StreamEvent {
    type: StreamEventType;
    data: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从同步上下文运行异步辅助函数。
 * 对应 Python _run_async_from_sync。
 */
function runAsyncFromSync<T>(coro: Promise<T>): T {
    // Node.js 中，如果已经在 event loop 中，直接 await 会工作
    // 这里我们总是返回 Promise，由调用方决定是否 await
    // 对应 Python 中用 ThreadPoolExecutor 处理已运行 event loop 的情况
    return coro as unknown as T;
}

// ════════════════════════════════════════════════════════════════════════════════
// DeerFlowClient
// ════════════════════════════════════════════════════════════════════════════════

export interface DeerFlowClientOptions {
    configPath?: string;
    checkpointer?: unknown;
    modelName?: string;
    thinkingEnabled?: boolean;
    subagentEnabled?: boolean;
    planMode?: boolean;
    agentName?: string;
    availableSkills?: Set<string>;
    environment?: string;
}

export class DeerFlowClient {
    private _appConfig: AppConfig;
    private _checkpointer: unknown;
    private _modelName: string | undefined;
    private _thinkingEnabled: boolean;
    private _subagentEnabled: boolean;
    private _planMode: boolean;
    private _agentName: string | undefined;
    private _availableSkills: Set<string> | undefined;
    private _environment: string | undefined;

    /** 延迟创建的 agent。 */
    private _agent: AgentInstance | null = null;
    /** agent 的配置 key，用于判断是否需要重建。 */
    private _agentConfigKey: string | null = null;

    constructor(options?: DeerFlowClientOptions) {
        if (options?.configPath) {
            invalidateConfigCache();
        }
        this._appConfig = getAppConfig();

        this._checkpointer = options?.checkpointer;
        this._modelName = options?.modelName;
        this._thinkingEnabled = options?.thinkingEnabled ?? true;
        this._subagentEnabled = options?.subagentEnabled ?? false;
        this._planMode = options?.planMode ?? false;
        this._agentName = options?.agentName;
        this._availableSkills = options?.availableSkills;
        this._environment = options?.environment;
    }

    /**
     * 强制重建内部 agent。
     * 对应 Python reset_agent。
     */
    resetAgent(): void {
        this._agent = null;
        this._agentConfigKey = null;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 内部方法
    // ════════════════════════════════════════════════════════════════════════════

    private _buildConfigKey(config: Record<string, unknown>): string {
        const cfg = (config.configurable as Record<string, unknown>) ?? {};
        return JSON.stringify({
            modelName: cfg.model_name ?? this._modelName,
            thinkingEnabled: cfg.thinking_enabled ?? this._thinkingEnabled,
            planMode: cfg.is_plan_mode ?? this._planMode,
            subagentEnabled: cfg.subagent_enabled ?? this._subagentEnabled,
            agentName: this._agentName,
            availableSkills: this._availableSkills ? [...this._availableSkills].sort() : null,
        });
    }

    private async _ensureAgent(config?: Record<string, unknown>): Promise<void> {
        const resolvedConfig = config ?? {};
        const key = this._buildConfigKey(resolvedConfig);
        const cfg = (resolvedConfig.configurable as Record<string, unknown>) ?? {};

        if (this._agent && this._agentConfigKey === key) {
            return;
        }

        const thinkingEnabled = (cfg.thinking_enabled as boolean) ?? this._thinkingEnabled;
        const subagentEnabled = (cfg.subagent_enabled as boolean) ?? this._subagentEnabled;

        // 通过 makeLeadAgent 创建 agent
        // 这会自动解析配置、构建工具、中间件和系统提示词
        this._agent = await makeLeadAgent({
            configurable: {
                model_name: cfg.model_name ?? this._modelName,
                thinking_enabled: thinkingEnabled,
                is_plan_mode: cfg.is_plan_mode ?? this._planMode,
                subagent_enabled: subagentEnabled,
                agent_name: this._agentName,
                thread_id: cfg.thread_id as string,
                run_id: cfg.run_id as string,
            },
        });

        this._agentConfigKey = key;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 对话 API
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * 流式对话。
     * 对应 Python stream。
     */
    async *stream(
        message: string,
        options?: {
            threadId?: string;
            modelName?: string;
            thinkingEnabled?: boolean;
            planMode?: boolean;
            subagentEnabled?: boolean;
            recursionLimit?: number;
        },
    ): AsyncGenerator<StreamEvent, void, unknown> {
        const threadId = options?.threadId ?? crypto.randomUUID();
        const runId = crypto.randomUUID();

        const config: Record<string, unknown> = {
            configurable: {
                thread_id: threadId,
                run_id: runId,
                model_name: options?.modelName ?? this._modelName,
                thinking_enabled: options?.thinkingEnabled ?? this._thinkingEnabled,
                is_plan_mode: options?.planMode ?? this._planMode,
                subagent_enabled: options?.subagentEnabled ?? this._subagentEnabled,
            },
        };

        await this._ensureAgent(config);

        if (!this._agent) {
            throw new Error("Agent not initialized");
        }

        const runtimeContext: RuntimeContext = {
            thread_id: threadId,
            run_id: runId,
            user_id: getEffectiveUserId(),
            agent_name: this._agentName,
        };

        const streamIter = this._agent.stream(message, {
            maxTurns: options?.recursionLimit ?? 25,
        });

        const cumulativeUsage: Record<string, number> = {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
        };

        for await (const chunk of streamIter) {
            if (chunk.type === "message") {
                yield {
                    type: "messages-tuple",
                    data: {
                        type: "ai",
                        content: chunk.content.content,
                        id: chunk.content.id,
                    },
                };
            } else if (chunk.type === "tool_call") {
                yield {
                    type: "messages-tuple",
                    data: {
                        type: "ai",
                        content: "",
                        id: chunk.content.id,
                        tool_calls: chunk.content.tool_calls ? [{
                            name: chunk.content.tool_calls[0]?.name,
                            args: chunk.content.tool_calls[0]?.args,
                            id: chunk.content.tool_calls[0]?.id,
                        }] : [],
                    },
                };
            } else if (chunk.type === "tool_result") {
                yield {
                    type: "messages-tuple",
                    data: {
                        type: "tool",
                        content: chunk.content.content,
                        name: chunk.content.name,
                        tool_call_id: chunk.content.tool_call_id,
                        id: chunk.content.id,
                    },
                };
            }
        }

        yield {
            type: "end",
            data: { usage: cumulativeUsage },
        };
    }

    /**
     * 发送消息并返回最终文本回复。
     * 对应 Python chat。
     */
    async chat(
        message: string,
        options?: {
            threadId?: string;
            modelName?: string;
            thinkingEnabled?: boolean;
            planMode?: boolean;
            subagentEnabled?: boolean;
        },
    ): Promise<string> {
        const chunks: Record<string, string[]> = {};
        let lastId = "";

        for await (const event of this.stream(message, options)) {
            if (event.type === "messages-tuple" && event.data.type === "ai") {
                const msgId = (event.data.id as string) ?? "";
                const delta = (event.data.content as string) ?? "";
                if (delta) {
                    chunks[msgId] = chunks[msgId] ?? [];
                    chunks[msgId].push(delta);
                    lastId = msgId;
                }
            }
        }

        return (chunks[lastId] ?? []).join("");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 配置查询
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * 列出可用模型。
     * 对应 Python list_models。
     */
    listModels(): Record<string, unknown> {
        return {
            models: (this._appConfig.models ?? []).map((model: Record<string, unknown>) => ({
                name: model.name,
                model: model.model,
                display_name: model.display_name,
                description: model.description,
                supports_thinking: model.supports_thinking ?? false,
                supports_reasoning_effort: model.supports_reasoning_effort ?? false,
            })),
        };
    }

    /**
     * 获取单个模型的配置。
     * 对应 Python get_model。
     */
    getModel(name: string): Record<string, unknown> | null {
        const model = getModelConfig(this._appConfig, name);
        if (!model) return null;
        return {
            name: model.name,
            model: model.model,
            display_name: model.display_name,
            description: model.description,
            supports_thinking: model.supports_thinking ?? false,
            supports_reasoning_effort: model.supports_reasoning_effort ?? false,
        };
    }

    // ════════════════════════════════════════════════════════════════════════════
    // 目标管理
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * 获取线程的活动目标。
     * 对应 Python get_goal。
     */
    async getGoal(threadId: string): Promise<{ goal: GoalState | null }> {
        const goal = await readThreadGoal(undefined, getEffectiveUserId());
        return { goal };
    }

    /**
     * 设置或替换线程范围的目标。
     * 对应 Python set_goal。
     */
    async setGoal(
        threadId: string,
        objective: string,
        maxContinuations: number = DEFAULT_MAX_GOAL_CONTINUATIONS,
    ): Promise<{ goal: GoalState }> {
        const goal = buildGoalState(objective, { maxContinuations });

        async function _setGoal(): Promise<void> {
            const release = await goalThreadLock(threadId);
            try {
                await writeThreadGoal(goal, undefined, getEffectiveUserId());
            } finally {
                release.release();
            }
        }

        await _setGoal();
        return { goal };
    }

    /**
     * 清除线程的活动目标。
     * 对应 Python clear_goal。
     */
    async clearGoal(threadId: string): Promise<{ goal: null }> {
        async function _clearGoal(): Promise<void> {
            const release = await goalThreadLock(threadId);
            try {
                await writeThreadGoal(null, undefined, getEffectiveUserId());
            } finally {
                release.release();
            }
        }

        try {
            await _clearGoal();
        } catch {
            // 忽略
        }
        return { goal: null };
    }
}
