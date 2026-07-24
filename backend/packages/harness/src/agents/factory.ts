/**
 * DeerFlow Agent 工厂 — 使用 @langchain/langgraph 的 StateGraph 构建 Agent。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/factory.py
 * 但使用 LangGraph 而非手写 agent 循环。
 *
 * 节点：
 *   "agent" — 调 LLM（含 beforeModel / afterModel 中间件）
 *   "tools" — 执行工具（含 beforeToolCall / afterToolCall 中间件）
 *
 * 路由：
 *   agent → 有 tool_calls ? "tools" : __end__
 *   tools → agent
 */

import { StateGraph, Annotation, END, START, messagesStateReducer, MemorySaver, Command } from "@langchain/langgraph";
import { BaseMessage, AIMessage, ToolMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ToolCall as LangChainToolCall } from "@langchain/core/messages/tool";

// ════════════════════════════════════════════════════════════════════════════════
// 消息类型
// ════════════════════════════════════════════════════════════════════════════════

export type ToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>;
};

export type Message = {
    type: "human" | "ai" | "tool" | "system";
    content: string;
    id?: string;
    name?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    status?: string;
    additional_kwargs?: Record<string, unknown>;
    usage_metadata?: Record<string, unknown>;
    response_metadata?: Record<string, unknown>;
    invalid_tool_calls?: Array<Record<string, unknown>>;
    [key: string]: unknown;
};

/** 运行时上下文（thread_id, user_id, run_id 等） */
export interface RuntimeContext {
    thread_id?: string;
    run_id?: string;
    user_id?: string;
    agent_name?: string;
    channel_user_id?: string;
    user_role?: string;
    oauth_provider?: string;
    oauth_id?: string;
    app_config?: Record<string, unknown>;
    disable_clarification?: boolean;
    subagent_enabled?: boolean;
    max_concurrent_subagents?: number;
    max_total_subagents?: number;
    [key: string]: unknown;
}

// ════════════════════════════════════════════════════════════════════════════════
// 中间件钩子
// ════════════════════════════════════════════════════════════════════════════════

export interface MiddlewareHooks {
    /** 模型调用前：修改消息列表 */
    beforeModel: Array<(messages: any[], context: RuntimeContext) => any[]>;
    /** 模型调用后：检查响应 */
    afterModel: Array<(messages: any[], context: RuntimeContext) => { messages?: any[] } | null>;
    /** 工具调用前：拦截或放行 */
    beforeToolCall: Array<(toolCall: ToolCall, context: RuntimeContext) => ToolCall | null>;
    /** 工具调用后：处理结果 */
    afterToolCall: Array<(result: any, toolCall: ToolCall, context: RuntimeContext) => any>;
    /** Agent 运行前 */
    beforeAgent: Array<(context: RuntimeContext) => void>;
    /** Agent 运行后 */
    afterAgent: Array<(context: RuntimeContext) => void>;
}

// ════════════════════════════════════════════════════════════════════════════════
// LangGraph State 定义
// ════════════════════════════════════════════════════════════════════════════════

/** 延迟工具提升状态。 */
interface PromotedState {
    catalog_hash?: string;
    names?: string[];
}

/**
 * DeerFlow Agent 的 LangGraph 状态定义。
 * 对应原项目 ThreadState。
 */
const AgentState = Annotation.Root({
    /** 对话消息列表。使用 built-in reducer 自动追加。 */
    messages: Annotation<BaseMessage[]>({
        reducer: messagesStateReducer,
        default: () => [],
    }),
    /** 运行时上下文信息（一次性设值）。 */
    thread_id: Annotation<string>({ default: () => "", reducer: (a, b) => b || a }),
    run_id: Annotation<string>({ default: () => "", reducer: (a, b) => b || a }),
    user_id: Annotation<string>({ default: () => "", reducer: (a, b) => b || a }),
    agent_name: Annotation<string>({ default: () => "", reducer: (a, b) => b || a }),
    /** 延迟工具提升状态。tool_search 工具通过 Command 写入此字段。 */
    promoted: Annotation<PromotedState>({
        default: () => ({}),
        reducer: (a, b) => ({ ...a, ...b }),
    }),
});

// ════════════════════════════════════════════════════════════════════════════════
// 运行时功能特性
// ════════════════════════════════════════════════════════════════════════════════

export interface RuntimeFeatures {
    sandbox?: boolean;
    guardrail?: boolean;
    summarization?: boolean;
    auto_title?: boolean;
    memory?: boolean;
    vision?: boolean;
    subagent?: boolean;
    loop_detection?: boolean;
    token_budget?: boolean;
    plan_mode?: boolean;
}

// ════════════════════════════════════════════════════════════════════════════════
// 中间件导入
// ════════════════════════════════════════════════════════════════════════════════

import { tryProcessSanitizeRequest } from "./middlewares/input_sanitization.js";
import { applyBudgetToHistory } from "./middlewares/tool_output_budget.js";
import { sanitizeToolResult } from "./middlewares/tool_result_sanitization.js";
import { setupThreadData } from "./middlewares/thread_data.js";
import { wrapToolCallWithSandbox, beforeAgentSandbox } from "./middlewares/sandbox_middleware.js";
import { fixDanglingToolCalls } from "./middlewares/dangling_tool_call.js";
import { auditBashCommand } from "./middlewares/sandbox_audit.js";
import { checkWriteGate, attachReadMark } from "./middlewares/read_before_write.js";
import { injectDynamicContext } from "./middlewares/dynamic_context.js";
import { processSlashSkillActivation } from "./middlewares/skill_activation.js";
import { captureDurableContext, injectDurableContext } from "./middlewares/durable_context.js";
import { shouldSummarize, applySummarization } from "./middlewares/summarization.js";
import { TodoTracker } from "./middlewares/todo.js";
import { annotateTokenUsage } from "./middlewares/token_usage.js";
import { generateTitle } from "./middlewares/title.js";
import { queueMemoryUpdate } from "./middlewares/memory_middleware.js";
import { injectViewImages } from "./middlewares/view_image.js";
import { createMcpRoutingMiddleware } from "./middlewares/mcp_routing.js";
import { createDeferredToolFilter } from "./middlewares/deferred_tool_filter.js";
import { coalesceSystemMessages } from "./middlewares/system_message_coalescing.js";
import { truncateTaskCalls } from "./middlewares/subagent_limit.js";
import { LoopDetector } from "./middlewares/loop_detection.js";
import { TokenBudgetTracker } from "./middlewares/token_budget.js";
import { applySafetyFinishReason } from "./middlewares/safety_finish_reason.js";
import { TerminalResponseTracker } from "./middlewares/terminal_response.js";
import { handleClarification } from "./middlewares/clarification.js";
import { normalizeToolResult } from "./middlewares/tool_result_meta.js";
import { extractResponseText } from "../utils/llm_text.js";

// ════════════════════════════════════════════════════════════════════════════════
// 中间件组装
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 根据功能开关组装中间件钩子链。
 * 返回的 hooks 会在 LandGraph 节点内部被调用。
 */
function assembleMiddlewareHooks(features: RuntimeFeatures, context: RuntimeContext): MiddlewareHooks {
    const hooks: MiddlewareHooks = {
        beforeModel: [],
        afterModel: [],
        beforeToolCall: [],
        afterToolCall: [],
        beforeAgent: [],
        afterAgent: [],
    };

    // ── [1-3] 输入处理 ──
    hooks.beforeModel.push((msgs: any) => tryProcessSanitizeRequest(msgs));
    hooks.beforeModel.push((msgs) => applyBudgetToHistory(msgs));
    hooks.afterToolCall.push((result, tc) => sanitizeToolResult(tc.name, result));

    // ── [4] ThreadData ──
    if (features.sandbox !== false) {
        hooks.beforeAgent.push((ctx) => {
            if (ctx.thread_id) {
                setupThreadData({ threadId: ctx.thread_id, context, lazyInit: true });
            }
        });
    }

    // ── [7] DanglingToolCall ──
    hooks.beforeModel.push((msgs) => fixDanglingToolCalls(msgs) ?? msgs);

    // ── [9] SandboxAudit ──
    hooks.beforeToolCall.push((tc) => {
        if (tc.name === "bash") {
            const audited = auditBashCommand(String(tc.args.command ?? ""), context.thread_id);
            if (audited.verdict === "block") return null;
        }
        return tc;
    });

    // ── [11] ReadBeforeWrite ──
    const rbwState: { messages: Message[] } = { messages: [] };
    hooks.beforeToolCall.push((tc) => {
        if (tc.name === "write_file" || tc.name === "str_replace") {
            const blocked = checkWriteGate(tc as any, rbwState.messages as any, () => "");
            if (blocked) return null;
        }
        return tc;
    });
    hooks.afterToolCall.push((result, tc) => {
        if (tc.name === "read_file") attachReadMark(tc as any, result as any, () => "");
        return result;
    });

    // ── [13] DynamicContext ──
    hooks.beforeModel.push((msgs) => {
        const result = injectDynamicContext(msgs, context.agent_name);
        return result?.messages ? (result.messages as Message[]) : msgs;
    });

    // ── [15] SkillActivation ──
    hooks.beforeModel.push((msgs) => {
        const result = processSlashSkillActivation(msgs, context);
        return result?.messages ? (result.messages as Message[]) : msgs;
    });

    // ── [16] DurableContext ──
    hooks.beforeModel.push((msgs) => injectDurableContext(msgs));
    hooks.afterModel.push((msgs) => { captureDurableContext(msgs, context); return null; });

    // ── [17] Summarization ──
    if (features.summarization) {
        hooks.afterModel.push((msgs) => {
            if (shouldSummarize(msgs)) {
                applySummarization(msgs, async (prompt: string) => {
                    // summarization 回调由 summarization middleware 提供
                    return null;
                });
            }
            return null;
        });
    }

    // ── [18] Todo ──
    if (features.plan_mode) {
        const todoTracker = new TodoTracker();
        hooks.afterModel.push((msgs) => {
            const reminder = (todoTracker as any).detectContextLoss?.(msgs, []) ?? null;
            return reminder ? { messages: [...msgs, reminder] } : null;
        });
    }

    // ── [19] TokenUsage ──
    hooks.afterModel.push((msgs) => {
        annotateTokenUsage(msgs, []);
        return null;
    });

    // ── [20] Title ──
    if (features.auto_title) {
        let titleGenerated = false;
        hooks.afterModel.push((msgs) => {
            if (!titleGenerated && msgs.length >= 2) {
                const result = generateTitle(msgs);
                if (result?.title) titleGenerated = true;
            }
            return null;
        });
    }

    // ── [21] Memory ──
    if (features.memory) {
        hooks.afterModel.push((msgs) => {
            queueMemoryUpdate(msgs as any, context.thread_id ?? "", context.agent_name);
            return null;
        });
    }

    // ── [22] ViewImage ──
    if (features.vision) {
        hooks.beforeModel.push((msgs) => {
            // ViewImageMiddleware 在 agent.py 中作用于 state 级别
            // 在 messages 模式中暂简化处理
            return msgs;
        });
    }

    // ── [23] McpRouting ──
    // 由 tool_search 构建时动态注入

    // ── [24] DeferredToolFilter ──
    // 由 tool_search 构建时动态注入

    // ── [25] SubagentLimit ──
    if (features.subagent) {
        hooks.afterModel.push((msgs) => {
            truncateTaskCalls(msgs, null, context);
            return null;
        });
    }

    // ── [26] LoopDetection ──
    if (features.loop_detection) {
        const loopDetector = new LoopDetector();
        const threadId = context.thread_id ?? "default";
        const runId = context.run_id ?? "default";
        hooks.afterModel.push((msgs) => {
            loopDetector.apply(msgs, threadId, runId);
            return null;
        });
        hooks.beforeModel.push((msgs) => {
            const augmented = loopDetector.augmentRequest(msgs, threadId, runId);
            return augmented ?? msgs;
        });
    }

    // ── [27] TokenBudget ──
    if (features.token_budget) {
        const budgetTracker = new TokenBudgetTracker({
            enabled: true,
            max_tokens: 100000,
            max_input_tokens: 0,
            max_output_tokens: 0,
            warn_threshold: 0.7,
            hard_stop_threshold: 1.0,
        });
        const runId = context.run_id ?? "default";
        hooks.afterModel.push((msgs) => {
            budgetTracker.apply(msgs, runId);
            return null;
        });
        hooks.beforeModel.push((msgs) => {
            const warnings = budgetTracker.drainPendingWarnings(runId);
            if (warnings.length > 0) {
                const warningMsgs = warnings.map(
                    (w: string) => ({ type: "system" as const, content: w }),
                );
                return [...warningMsgs, ...msgs];
            }
            return msgs;
        });
    }

    // ── [28] SafetyFinishReason ──
    hooks.afterModel.push((msgs) => {
        const result = applySafetyFinishReason(msgs);
        return result?.messages ? result : null;
    });

    // ── [29] TerminalResponse ──
    const terminalTracker = new TerminalResponseTracker();
    const threadIdT = context.thread_id ?? "default";
    const runIdT = context.run_id ?? "default";
    hooks.afterModel.push((msgs) => {
        const result = terminalTracker.apply(msgs, threadIdT, runIdT);
        return result ?? null;
    });
    hooks.beforeModel.push((msgs) => {
        const augmented = terminalTracker.augmentRequest(msgs, threadIdT, runIdT);
        return augmented ?? msgs;
    });

    // ── [30] Clarification ──
    hooks.beforeToolCall.push((tc) => {
        const result = handleClarification(tc as any, context.disable_clarification);
        if (result.type !== "passthrough") return null;
        return tc;
    });

    return hooks;
}

// ════════════════════════════════════════════════════════════════════════════════
// Agent 实例接口
// ════════════════════════════════════════════════════════════════════════════════

export interface AgentInstance {
    name: string;
    invoke(input: string | Message[], config?: { maxTurns?: number }): Promise<{
        messages: Message[];
        finalOutput: string;
    }>;
    stream(input: string | Message[], config?: { maxTurns?: number }): AsyncIterable<{
        type: "message" | "tool_call" | "tool_result";
        content: Message;
    }>;
}

// ════════════════════════════════════════════════════════════════════════════════
// 工厂配置
// ════════════════════════════════════════════════════════════════════════════════

export interface AgentFactoryOptions {
    model: BaseChatModel;
    tools: Array<{
        name: string;
        invoke: (args: Record<string, unknown>) => Promise<unknown> | unknown;
        description?: string;
    }>;
    systemPrompt?: string;
    features?: RuntimeFeatures;
    context?: RuntimeContext;
    name?: string;
}

// ════════════════════════════════════════════════════════════════════════════════
// LangGraph 节点函数
// ════════════════════════════════════════════════════════════════════════════════

type GraphState = typeof AgentState.State;

/**
 * 构建 agent 节点函数。
 * 调用 LLM，并在前后执行 beforeModel / afterModel 中间件。
 */
function buildAgentNode(
    model: BaseChatModel,
    hooks: MiddlewareHooks,
    context: RuntimeContext,
    systemPrompt?: string,
) {
    return async (state: GraphState, config?: RunnableConfig): Promise<Partial<GraphState>> => {
        let messages = [...state.messages];

        // ── beforeModel 中间件 ──
        for (const hook of hooks.beforeModel) {
            messages = hook(messages, context) as BaseMessage[];
        }

        // ── 插入系统提示 ──
        if (systemPrompt) {
            const firstMsg = messages[0] as unknown as Record<string, unknown> | undefined;
            const hasSystem = firstMsg?.type === "system";
            if (!hasSystem) {
                messages = [new SystemMessage(systemPrompt), ...messages];
            }
        }

        // ── 合并连续的系统消息 ──
        const coalesced = coalesceSystemMessages(null, messages as unknown as Record<string, unknown>[]);
        if (coalesced?.messages) {
            messages = coalesced.messages as unknown as BaseMessage[];
        }

        // ── 调 LLM ──
        const response = await model.invoke(messages, config);
        messages = [...messages, response];

        // ── afterModel 中间件 ──
        for (const hook of hooks.afterModel) {
            const result = hook(messages, context);
            if (result?.messages) {
                messages = result.messages as BaseMessage[];
            }
        }

        return { messages };
    };
}

/**
 * 构建 tools 节点函数。
 * 执行 AI 消息中的工具调用，并在前后执行 beforeToolCall / afterToolCall 中间件。
 */
function buildToolsNode(
    tools: AgentFactoryOptions["tools"],
    hooks: MiddlewareHooks,
    context: RuntimeContext,
) {
    return async (state: GraphState): Promise<Partial<GraphState>> => {
        const lastMessage = state.messages[state.messages.length - 1];
        const toolCalls = (lastMessage as AIMessage)?.tool_calls ?? [];
        if (toolCalls.length === 0) return {};

        const results: ToolMessage[] = [];

        for (const tc of toolCalls) {
            // ── beforeToolCall 中间件 ──
            let currentTc: LangChainToolCall | null = tc;
            for (const hook of hooks.beforeToolCall) {
                const mapped = hook(
                    { id: currentTc.id ?? "", name: currentTc.name ?? "", args: currentTc.args ?? {} },
                    context,
                );
                if (mapped === null) {
                    currentTc = null;
                    break;
                }
                currentTc = mapped as unknown as LangChainToolCall;
            }
            if (!currentTc) continue;

            // ── 查找并执行工具 ──
            const tool = tools.find((t) => t.name === currentTc!.name);
            if (!tool) {
                results.push(new ToolMessage({
                    content: `Unknown tool: ${currentTc!.name}`,
                    tool_call_id: currentTc!.id ?? currentTc!.name ?? "",
                    name: currentTc!.name,
                    status: "error",
                }));
                continue;
            }

            let rawResult: unknown;
            try {
                rawResult = await tool.invoke(currentTc!.args ?? {});
            } catch (error) {
                rawResult = `Error: ${(error as Error).message}`;
            }

            const contentStr = typeof rawResult === "string"
                ? rawResult
                : JSON.stringify(rawResult);

            let toolMessage = new ToolMessage({
                content: contentStr,
                tool_call_id: currentTc!.id ?? currentTc!.name ?? "",
                name: currentTc!.name,
                status: "success",
            });

            // ── afterToolCall 中间件 ──
            for (const hook of hooks.afterToolCall) {
                toolMessage = hook(toolMessage, {
                    id: currentTc!.id ?? "",
                    name: currentTc!.name ?? "",
                    args: currentTc!.args ?? {},
                }, context) as ToolMessage;
            }

            // ── 打 deerflow_tool_meta ──
            normalizeToolResult(toolMessage as any);

            results.push(toolMessage);
        }

        return { messages: results };
    };
}

/**
 * 条件路由：判断是否需要继续调工具。
 * agent → 有 tool_calls → "tools"，否则 → __end__
 */
function shouldContinue(state: GraphState): string | typeof END {
    const messages = state.messages;
    if (messages.length === 0) return END;
    const lastMessage = messages[messages.length - 1];
    const toolCalls = (lastMessage as AIMessage)?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
        return "tools";
    }
    return END;
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助：消息格式转换
// ════════════════════════════════════════════════════════════════════════════════

function toLangChainMessage(msg: Message): BaseMessage {
    switch (msg.type) {
        case "human":
            return new HumanMessage({ content: msg.content, additional_kwargs: msg.additional_kwargs ?? {} });
        case "ai":
            return new AIMessage({
                content: msg.content,
                tool_calls: msg.tool_calls?.map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    args: tc.args,
                    type: "tool_call" as const,
                })),
                additional_kwargs: msg.additional_kwargs ?? {},
            });
        case "tool":
            return new ToolMessage({
                content: msg.content,
                tool_call_id: msg.tool_call_id ?? "",
                name: msg.name,
                status: (msg.status === "error" ? "error" : "success") as "success" | "error",
                additional_kwargs: msg.additional_kwargs,
            });
        case "system":
            return new SystemMessage(msg.content);
        default:
            return new HumanMessage(msg.content);
    }
}

function fromLangChainMessage(msg: BaseMessage): Message {
    const msgAny = msg as unknown as Record<string, unknown>;
    const base: Message = {
        type: (msgAny.type as "human" | "ai" | "tool" | "system") ?? "human",
        content: extractResponseText(msg.content),
    };
    const aiMsg = msg as AIMessage;
    if (aiMsg.tool_calls) {
        base.tool_calls = aiMsg.tool_calls.map((tc) => ({
            id: tc.id ?? tc.name,
            name: tc.name,
            args: tc.args ?? {},
        }));
    }
    const toolMsg = msg as ToolMessage;
    if (toolMsg.tool_call_id) base.tool_call_id = toolMsg.tool_call_id;
    if (toolMsg.name) base.name = toolMsg.name;
    if (toolMsg.status) base.status = toolMsg.status as string;
    if (msg.additional_kwargs && Object.keys(msg.additional_kwargs).length > 0) {
        base.additional_kwargs = msg.additional_kwargs as Record<string, unknown>;
    }
    const usage = (msg as unknown as Record<string, unknown>).usage_metadata;
    if (usage) base.usage_metadata = usage as Record<string, unknown>;
    return base;
}

// ════════════════════════════════════════════════════════════════════════════════
// 工厂入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 创建 DeerFlow Agent 实例。
 * 内部使用 @langchain/langgraph 的 StateGraph 构建 agent 图。
 *
 * @param options 配置选项
 * @returns AgentInstance
 */
export function createDeerFlowAgent(options: AgentFactoryOptions): AgentInstance {
    const {
        model,
        tools,
        systemPrompt,
        features = {},
        context = {},
        name = "deerflow",
    } = options;

    // 组装中间件
    const hooks = assembleMiddlewareHooks(features, context);

    // ── beforeAgent ──
    for (const hook of hooks.beforeAgent) {
        hook(context);
    }

    // ── 构建 LangGraph ──
    const agentNode = buildAgentNode(model, hooks, context, systemPrompt);
    const toolsNode = buildToolsNode(tools, hooks, context);

    const graph = new StateGraph(AgentState)
        .addNode("agent", agentNode)
        .addNode("tools", toolsNode)
        .addEdge(START, "agent")
        .addConditionalEdges("agent", shouldContinue)
        .addEdge("tools", "agent")
        .compile();

    // ── 封装 invoke / stream ──

    async function invoke(
        input: string | Message[],
        invokeConfig?: { maxTurns?: number },
    ): Promise<{ messages: Message[]; finalOutput: string }> {
        const inputMessages: BaseMessage[] = Array.isArray(input)
            ? input.map(toLangChainMessage)
            : [new HumanMessage(input)];

        const state = await graph.invoke(
            { messages: inputMessages },
            { recursionLimit: invokeConfig?.maxTurns ?? 25 },
        );

        const messages: Message[] = (state.messages as BaseMessage[]).map(fromLangChainMessage);

        // ── afterAgent ──
        for (const hook of hooks.afterAgent) {
            hook(context);
        }

        const lastMsg = messages[messages.length - 1];
        return {
            messages,
            finalOutput: lastMsg?.content ?? "",
        };
    }

    async function* stream(
        input: string | Message[],
        streamConfig?: { maxTurns?: number },
    ): AsyncIterable<{ type: "message" | "tool_call" | "tool_result"; content: Message }> {
        const inputMessages: BaseMessage[] = Array.isArray(input)
            ? input.map(toLangChainMessage)
            : [new HumanMessage(input)];

        const stream = await graph.stream(
            { messages: inputMessages },
            { recursionLimit: streamConfig?.maxTurns ?? 25 },
        );

        for await (const chunk of stream) {
            // chunk 形如 { agent: { messages: [...] }, tools: { messages: [...] } }
            const nodeName = Object.keys(chunk)[0];
            const data = (chunk as Record<string, unknown>)[nodeName] as Record<string, unknown> | undefined;

            if (data?.messages) {
                const msgs = data.messages as BaseMessage[];
                for (const msg of msgs) {
                    const converted = fromLangChainMessage(msg);
                    if (converted.type === "ai" && converted.tool_calls?.length) {
                        yield { type: "tool_call" as const, content: converted };
                    } else {
                        yield { type: "message" as const, content: converted };
                    }
                }
            }
        }

        // ── afterAgent ──
        for (const hook of hooks.afterAgent) {
            hook(context);
        }
    }

    return { name, invoke, stream };
}
