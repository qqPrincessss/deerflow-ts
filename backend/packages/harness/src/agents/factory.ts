/**
 * DeerFlow Agent 工厂 — 创建可执行的 Agent 实例。
 *
 * 使用 LangChain BaseChatModel 调用 LLM，我们自己的中间件链和工具执行逻辑。
 */

import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { type BaseChatModel } from "@langchain/core/language_models/chat_models";

// ════════════════════════════════════════════════════════════════════════════════
// 消息类型
// ════════════════════════════════════════════════════════════════════════════════

export type Message = {
    type: "human" | "ai" | "tool" | "system";
    content: string;
    id?: string;
    name?: string;
    tool_calls?: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
    }>;
    tool_call_id?: string;
    status?: string;
    additional_kwargs?: Record<string, unknown>;
    usage_metadata?: Record<string, unknown>;
    [key: string]: unknown;
};

// ════════════════════════════════════════════════════════════════════════════════
// Agent 实例
// ════════════════════════════════════════════════════════════════════════════════

export interface AgentInstance {
    /** Agent 名称 */
    name: string;

    /** 执行一轮 Agent 循环（最多 maxTurns 轮） */
    invoke(input: string | Message[], config?: { maxTurns?: number }): Promise<{
        messages: Message[];
        finalOutput: string;
    }>;

    /** 流式执行 */
    stream(input: string | Message[], config?: { maxTurns?: number }): AsyncIterable<{
        type: "message" | "tool_call" | "tool_result";
        content: Message;
    }>;
}

// ════════════════════════════════════════════════════════════════════════════════
// Agent 工厂
// ════════════════════════════════════════════════════════════════════════════════

export interface AgentFactoryOptions {
    model: BaseChatModel;
    systemPrompt?: string;
    name?: string;
}

/**
 * 创建 DeerFlow Agent。
 */
export function createDeerFlowAgent(options: AgentFactoryOptions): AgentInstance {
    const { model, systemPrompt, name = "deerflow" } = options;

    function prepareMessages(input: string | Message[]): Message[] {
        const messages: Message[] = Array.isArray(input)
            ? [...input]
            : [{ type: "human", content: input }];

        if (systemPrompt) {
            const hasSystem = messages.length > 0 && messages[0].type === "system";
            if (!hasSystem) {
                messages.unshift({ type: "system", content: systemPrompt });
            }
        }

        return messages;
    }

    /**
     * 将内部 Message 转为 LangChain 消息对象用于模型调用。
     */
    function toLangChainMessages(messages: Message[]): any[] {
        return messages.map((m) => {
            switch (m.type) {
                case "human":
                    return new HumanMessage({ content: m.content, additional_kwargs: m.additional_kwargs ?? {} });
                case "ai":
                    return {
                        constructor: { name: "AIMessage" },
                        content: m.content,
                        tool_calls: m.tool_calls,
                        additional_kwargs: m.additional_kwargs ?? {},
                    };
                case "tool":
                    return new ToolMessage({
                        content: m.content,
                        tool_call_id: m.tool_call_id ?? "",
                        name: m.name,
                        status: (m.status === "error" ? "error" : "success") as "success" | "error",
                    });
                case "system":
                    return new SystemMessage(m.content);
                default:
                    return new HumanMessage(m.content);
            }
        });
    }

    /**
     * 从 LangChain 回复中提取 tool_calls。
     */
    function extractToolCalls(lcMessage: any): Message["tool_calls"] {
        // LangChain AI message 的 tool_calls 格式
        if (lcMessage.tool_calls && Array.isArray(lcMessage.tool_calls)) {
            return lcMessage.tool_calls.map((tc: any) => ({
                id: tc.id ?? tc.name,
                name: tc.name,
                args: tc.args ?? {},
            }));
        }
        // 兼容 additional_kwargs 中的原始格式
        const raw = lcMessage.additional_kwargs?.tool_calls;
        if (raw && Array.isArray(raw)) {
            return raw.map((tc: any) => ({
                id: tc.id ?? tc.function?.name ?? "unknown",
                name: tc.function?.name ?? tc.name ?? "unknown",
                args: (() => {
                    try { return JSON.parse(tc.function?.arguments ?? "{}"); }
                    catch { return {}; }
                })(),
            }));
        }
        return [];
    }

    return {
        name,

        async invoke(input: string | Message[], config?: { maxTurns?: number }) {
            const messages = prepareMessages(input);
            const maxTurns = config?.maxTurns ?? 10;

            for (let turn = 0; turn < maxTurns; turn++) {
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
                };
                messages.push(aiMessage);

                // 没有工具调用 → 结束
                if (!toolCalls || toolCalls.length === 0) {
                    return { messages, finalOutput: content };
                }

                // 执行工具调用
                // 注意：工具需要在外部注册，这里只放入 tool_calls 信息
                // 实际工具执行由外部调用方处理
                for (const tc of (toolCalls ?? [])) {
                    messages.push({
                        type: "tool",
                        content: `Tool '${tc.name}' needs to be executed with args: ${JSON.stringify(tc.args)}`,
                        tool_call_id: tc.id,
                        name: tc.name,
                    });
                }
            }

            const lastMsg = messages[messages.length - 1];
            return {
                messages,
                finalOutput: lastMsg.content ?? "Max turns reached",
            };
        },

        async *stream(input: string | Message[], config?: { maxTurns?: number }) {
            const messages = prepareMessages(input);
            const maxTurns = config?.maxTurns ?? 10;

            for (let turn = 0; turn < maxTurns; turn++) {
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
                };
                
                messages.push(aiMessage);
                yield { type: "message" as const, content: aiMessage };

                if (!toolCalls || toolCalls.length === 0) break;

                for (const tc of (toolCalls ?? [])) {
                    yield { type: "tool_call" as const, content: { type: "tool", content: "", tool_call_id: tc.id, name: tc.name, tool_calls: [tc] } as any };
                }
            }
        },
    };
}
