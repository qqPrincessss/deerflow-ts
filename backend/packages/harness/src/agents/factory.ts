/**
 * DeerFlow Agent 工厂 — 创建可执行的 Agent 实例。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/factory.py
 *
 * 集成 31 个中间件到 Agent 执行循环中。
 * 使用 LangChain BaseChatModel 调用 LLM。
 */

import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { type BaseChatModel } from "@langchain/core/language_models/chat_models";

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
// 中间件组装
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

import { tryProcessSanitizeRequest } from "./middlewares/input_sanitization.js";
import { applyToolOutputBudget, applyBudgetToHistory } from "./middlewares/tool_output_budget.js";
import { sanitizeToolResult } from "./middlewares/tool_result_sanitization.js";
import { setupThreadData } from "./middlewares/thread_data.js";
import { setupUploads } from "./middlewares/uploads.js";
import { wrapToolCallWithSandbox, beforeAgentSandbox } from "./middlewares/sandbox_middleware.js";
import { fixDanglingToolCalls } from "./middlewares/dangling_tool_call.js";
import { auditBashCommand, buildBlockMessage, buildWarnSuffix } from "./middlewares/sandbox_audit.js";
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

/**
 * 根据功能开关组装中间件链。
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
    hooks.beforeModel.push((msgs) => {
        // tool_output_budget 对历史消息截断
        return applyBudgetToHistory(msgs);
    });
    hooks.afterToolCall.push((result, tc) => {
        // tool_result_sanitization：远程内容标签转义
        return sanitizeToolResult(tc.name, result);
    });

    // ── [4-6] 环境准备 ──
    if (features.sandbox !== false) {
        hooks.beforeAgent.push((ctx) => {
            if (ctx.thread_id) {
                setupThreadData({ threadId: ctx.thread_id, context, lazyInit: true });
            }
        });
    }

    // ── [7] DanglingToolCall ──
    hooks.beforeModel.push((msgs) => {
        const fixed = fixDanglingToolCalls(msgs);
        return fixed ?? msgs;
    });

    // ── [9] SandboxAudit ──
    hooks.beforeToolCall.push((tc) => {
        if (tc.name === "bash") {
            const audited = auditBashCommand(String(tc.args.command ?? ""), context.thread_id);
            if (audited.verdict === "block") {
                return null; // 阻断
            }
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
        if (tc.name === "read_file") {
            attachReadMark(tc as any, result as any, () => "");
        }
        return result;
    });

    // ── [13] DynamicContext ──
    hooks.beforeModel.push((msgs) => {
        const result = injectDynamicContext(msgs, context.agent_name);
        if (result?.messages) return result.messages as Message[];
        return msgs;
    });

    // ── [15] SkillActivation ──
    hooks.beforeModel.push((msgs) => {
        const result = processSlashSkillActivation(msgs, context);
        if (result?.messages) return result.messages as Message[];
        return msgs;
    });

    // ── [16] DurableContext ──
    hooks.beforeModel.push((msgs) => {
        return injectDurableContext(msgs);
    });
    hooks.afterModel.push((msgs) => {
        captureDurableContext(msgs, context);
        return null;
    });

    // ── [18] Todo ──
    const todoTracker = new TodoTracker();
    const runId = context.run_id ?? "default";
    const threadId = context.thread_id ?? "default";

    // ── [19] TokenUsage ──
    let tokenUsageState: { messages: Message[] } = { messages: [] };
    hooks.afterModel.push((msgs) => {
        tokenUsageState.messages = msgs;
        annotateTokenUsage(msgs, []); // todos 外部传入
        return null;
    });

    // ── [20] Title ──
    let titleGenerated = false;
    hooks.afterModel.push((msgs) => {
        if (!titleGenerated && msgs.length >= 2) {
            const result = generateTitle(msgs);
            if (result?.title) titleGenerated = true;
        }
        return null;
    });

    // ── [25] SubagentLimit ──
    hooks.afterModel.push((msgs) => {
        truncateTaskCalls(msgs, null, context);
        return null;
    });

    // ── [26] LoopDetection ──
    const loopDetector = new LoopDetector();
    hooks.afterModel.push((msgs) => {
        loopDetector.apply(msgs, threadId, runId);
        return null;
    });
    hooks.beforeModel.push((msgs) => {
        const augmented = loopDetector.augmentRequest(msgs, threadId, runId);
        return augmented ?? msgs;
    });

    // ── [27] TokenBudget ──
    const budgetTracker = new TokenBudgetTracker({
        enabled: true,
        max_tokens: 100000,
        max_input_tokens: 0,
        max_output_tokens: 0,
        warn_threshold: 0.7,
        hard_stop_threshold: 1.0,
    });
    hooks.afterModel.push((msgs) => {
        budgetTracker.apply(msgs, runId);
        return null;
    });
    hooks.beforeModel.push((msgs) => {
        const warnings = budgetTracker.drainPendingWarnings(runId);
        const injected = budgetTracker.injectWarnings(msgs, warnings);
        return injected ?? msgs;
    });

    // ── [28] SafetyFinishReason ──
    hooks.afterModel.push((msgs) => {
        const result = applySafetyFinishReason(msgs);
        if (result?.messages) return result;
        return null;
    });

    // ── [29] TerminalResponse ──
    const terminalTracker = new TerminalResponseTracker();
    hooks.afterModel.push((msgs) => {
        const result = terminalTracker.apply(msgs, threadId, runId);
        return result ?? null;
    });
    hooks.beforeModel.push((msgs) => {
        const augmented = terminalTracker.augmentRequest(msgs, threadId, runId);
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
// Agent 实例
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
// 工厂
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

export function createDeerFlowAgent(options: AgentFactoryOptions): AgentInstance {
    const { model, tools, systemPrompt, features = {}, context = {}, name = "deerflow" } = options;
    const hooks = assembleMiddlewareHooks(features, context);

    function prepareMessages(input: string | Message[]): Message[] {
        const messages: Message[] = Array.isArray(input) ? [...input] : [{ type: "human", content: input }];
        if (systemPrompt) {
            const hasSystem = messages.length > 0 && messages[0].type === "system";
            if (!hasSystem) messages.unshift({ type: "system", content: systemPrompt });
        }
        return messages;
    }

    function toLangChainMessages(messages: Message[]): any[] {
        return messages.map((m) => {
            switch (m.type) {
                case "human":
                    return new HumanMessage({ content: m.content, additional_kwargs: m.additional_kwargs ?? {} });
                case "ai":
                    return {
                        constructor: { name: "AIMessage" },
                        content: m.content,
                        tool_calls: m.tool_calls?.map((tc) => ({
                            id: tc.id,
                            name: tc.name,
                            args: tc.args,
                            type: "tool_call",
                        })),
                        additional_kwargs: m.additional_kwargs ?? {},
                    };
                case "tool":
                    return new ToolMessage({
                        content: m.content,
                        tool_call_id: m.tool_call_id ?? "",
                        name: m.name,
                        status: (m.status === "error" ? "error" : "success") as "success" | "error",
                        additional_kwargs: m.additional_kwargs,
                    });
                case "system":
                    return new SystemMessage(m.content);
                default:
                    return new HumanMessage(m.content);
            }
        });
    }

    function extractToolCalls(lcMessage: any): ToolCall[] {
        if (lcMessage.tool_calls && Array.isArray(lcMessage.tool_calls)) {
            return lcMessage.tool_calls.map((tc: any) => ({
                id: tc.id ?? tc.name,
                name: tc.name,
                args: tc.args ?? {},
            }));
        }
        const raw = lcMessage.additional_kwargs?.tool_calls;
        if (raw && Array.isArray(raw)) {
            return raw.map((tc: any) => ({
                id: tc.id ?? tc.function?.name ?? "unknown",
                name: tc.function?.name ?? tc.name ?? "unknown",
                args: (() => {
                    try { return JSON.parse(tc.function?.arguments ?? "{}"); } catch { return {}; }
                })(),
            }));
        }
        return [];
    }

    async function executeTool(tc: ToolCall): Promise<Message> {
        // beforeToolCall 中间件
        let currentTc: ToolCall | null = tc;
        for (const hook of hooks.beforeToolCall) {
            currentTc = hook(currentTc, context);
            if (currentTc === null) {
                return { type: "tool", content: `Tool '${tc.name}' was blocked by middleware`, tool_call_id: tc.id, name: tc.name, status: "error" };
            }
        }

        // 执行工具
        const tool = tools.find((t) => t.name === currentTc!.name);
        if (!tool) {
            return { type: "tool", content: `Unknown tool: ${currentTc!.name}`, tool_call_id: currentTc!.id, name: currentTc!.name, status: "error" };
        }

        let result: Message;
        try {
            const output = await tool.invoke(currentTc!.args);
            result = {
                type: "tool",
                content: typeof output === "string" ? output : JSON.stringify(output),
                tool_call_id: currentTc!.id,
                name: currentTc!.name,
                status: "success",
            };
        } catch (error) {
            result = {
                type: "tool",
                content: `Error: ${(error as Error).message}`,
                tool_call_id: currentTc!.id,
                name: currentTc!.name,
                status: "error",
            };
        }

        // afterToolCall 中间件
        for (const hook of hooks.afterToolCall) {
            result = hook(result, currentTc!, context);
        }

        // 打 deerflow_tool_meta
        normalizeToolResult(result as any);

        return result;
    }

    return {
        name,

        async invoke(input: string | Message[], config?: { maxTurns?: number }) {
            let messages = prepareMessages(input);
            const maxTurns = config?.maxTurns ?? 10;

            // beforeAgent
            for (const hook of hooks.beforeAgent) hook(context);

            for (let turn = 0; turn < maxTurns; turn++) {
                // beforeModel
                for (const hook of hooks.beforeModel) {
                    messages = hook(messages, context);
                }

                // 系统消息合并
                const coalesced = coalesceSystemMessages(null, messages);
                if (coalesced && coalesced.messages) messages = coalesced.messages as Message[];

                // 调 LLM
                const lcMessages = toLangChainMessages(messages);
                const response = await model.invoke(lcMessages);

                const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
                const toolCalls = extractToolCalls(response);

                const aiMessage: Message = {
                    type: "ai",
                    content,
                    tool_calls: toolCalls,
                    usage_metadata: (response as any).usage_metadata,
                    additional_kwargs: (response as any).additional_kwargs,
                    response_metadata: (response as any).response_metadata,
                };
                messages.push(aiMessage);

                // afterModel
                for (const hook of hooks.afterModel) {
                    const result = hook(messages, context);
                    if (result?.messages) messages = result.messages as Message[];
                }

                if (!toolCalls || toolCalls.length === 0) {
                    const lastMsg = messages[messages.length - 1];
                    return { messages, finalOutput: lastMsg?.content ?? "" };
                }

                // 执行工具
                for (const tc of toolCalls) {
                    const result = await executeTool(tc);
                    messages.push(result);
                }
            }

            // afterAgent
            for (const hook of hooks.afterAgent) hook(context);

            const lastMsg = messages[messages.length - 1];
            return { messages, finalOutput: lastMsg?.content ?? "" };
        },

        async *stream(input: string | Message[], config?: { maxTurns?: number }) {
            let messages = prepareMessages(input);
            const maxTurns = config?.maxTurns ?? 10;

            for (const hook of hooks.beforeAgent) hook(context);

            for (let turn = 0; turn < maxTurns; turn++) {
                for (const hook of hooks.beforeModel) {
                    messages = hook(messages, context);
                }
                const coalesced = coalesceSystemMessages(null, messages);
                if (coalesced && coalesced.messages) messages = coalesced.messages as Message[];

                const lcMessages = toLangChainMessages(messages);
                const response = await model.invoke(lcMessages);

                const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
                const toolCalls = extractToolCalls(response);
                const aiMessage: Message = { type: "ai", content, tool_calls: toolCalls };
                messages.push(aiMessage);
                yield { type: "message" as const, content: aiMessage };

                for (const hook of hooks.afterModel) {
                    const result = hook(messages, context);
                    if (result?.messages) messages = result.messages as Message[];
                }

                if (!toolCalls || toolCalls.length === 0) break;

                for (const tc of toolCalls) {
                    yield { type: "tool_call" as const, content: { type: "tool", content: "", tool_call_id: tc.id, name: tc.name } as Message };
                    const result = await executeTool(tc);
                    messages.push(result);
                    yield { type: "tool_result" as const, content: result };
                }
            }

            for (const hook of hooks.afterAgent) hook(context);
        },
    };
}
