const ROLE_MAP: Record<string, string> = {
    human: "user",
    ai: "assistant",
    system: "system",
    tool: "tool",
};
export function langchainToOpenaiMessage(message: Record<string, unknown>): Record<string, unknown> {
    //取出type和role
    const msgType = (message.type as string) || "";
    const role = ROLE_MAP[msgType] || msgType;
    const content = message.content ?? "";

    //如果是tool消息加tool——callid
    if (role === "tool") {
        return {
            role: "tool",
            tool_call_id: message.tool_call_id ?? "",
            content: content
        }
    }

    //如果是ai消息且消息有tool_calls
    if (role === "assistant") {
        const toolCalls = (message.tool_calls as Array<Record<string, unknown>>) || [];
        const result: Record<string, unknown> = { role: "assistant" };

        if (toolCalls.length > 0) {
            const openaiToolCalls = toolCalls.map((tc) => {
                const args = tc.args ?? {}
                return {
                    id: tc.id ?? "",
                    type: "function",
                    function: {
                        name: tc.name ?? "",
                        arguments: typeof args === "string" ? args : JSON.stringify(args),
                    }
                }
            });
            result.content = content || null;
            result.tool_calls = openaiToolCalls;
        } else {
            result.content = content;
        }
        return result;
    }
    return { role, content };

}

/**
 * 推断 finish_reason。
 *
 * 有 tool_calls → "tool_calls"
 * response_metadata 里有 finish_reason → 用它
 * 否则 → "stop"
 */
function inferFinishReason(message: Record<string, unknown>): string {
    const toolCalls = (message.tool_calls as Array<unknown>) || [];
    if (toolCalls.length > 0) return "tool_calls";
    const respMeta = message.response_metadata as Record<string, unknown> | undefined;
    if (respMeta?.finish_reason) return respMeta.finish_reason as string;
    return "stop";
}

/**
 * 把AImessage转成OpenAI completion格式
 */
export function langchainToOpenaiCompletion(message: Record<string, unknown>):
    Record<string, unknown> {
    const respMeta = (message.response_metadata as Record<string, unknown>) || {};
    const modelName = respMeta.model_name;
    const openaiMsg = langchainToOpenaiMessage(message);
    const finishReason = inferFinishReason(message);

    let usage: Record<string, number> | null = null;
    const usageMetadata = message.usage_metadata as Record<string, unknown> |
        undefined;
    if (usageMetadata) {
        const inputTokens = (usageMetadata.input_tokens as number) || 0;
        const outputTokens = (usageMetadata.output_tokens as number) || 0;
        usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
        };
    }

    return {
        id: message.id ?? null,
        model: modelName,
        choices: [{ index: 0, message: openaiMsg, finish_reason: finishReason }],
        usage,
    };
}

/**
 * 批量转换消息列表。
 */
export function langchainMessagesToOpenai(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return messages.map(langchainToOpenaiMessage);
}