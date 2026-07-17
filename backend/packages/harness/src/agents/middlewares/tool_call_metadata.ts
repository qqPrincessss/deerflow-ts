/**
 * AIMessage 工具调用元数据同步。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/tool_call_metadata.py
 *
 * 场景：中间件可能会修改 AIMessage 的 tool_calls（比如截断多余的调用）。
 * 修改后，要同步更新 additional_kwargs 里的原始工具调用元数据，
 * 保持两者一致。
 */

/**
 * 从原始工具调用中提取 ID。
 */
function rawToolCallId(rawToolCall: unknown): string | null {
    if (!rawToolCall || typeof rawToolCall !== "object") return null;
    const id = (rawToolCall as Record<string, unknown>).id;
    return typeof id === "string" && id ? id : null;
}

/**
 * 克隆 AIMessage，同步更新工具调用元数据。
 *
 * 对应原项目 clone_ai_message_with_tool_calls。
 *
 * 当中间件修改了 tool_calls 列表（比如截断多余的调用），
 * 这个函数确保 additional_kwargs 里的原始工具调用也同步更新。
 *
 * @param message 原始 AIMessage
 * @param toolCalls 新的 tool_calls 列表
 * @param content 可选的新内容
 * @returns 克隆后的 AIMessage
 */
export function cloneAiMessageWithToolCalls(
    message: Record<string, unknown>,
    toolCalls: Array<Record<string, unknown>>,
    content?: unknown
): Record<string, unknown> {
    // 收集保留的 tool_call ID
    const keptIds = new Set(
        toolCalls
            .filter((tc) => typeof tc.id === "string" && tc.id)
            .map((tc) => tc.id as string)
    );

    // 构建更新对象
    const update: Record<string, unknown> = { tool_calls: toolCalls };
    if (content !== undefined) {
        update.content = content;
    }

    // 同步 additional_kwargs 里的原始工具调用
    const additionalKwargs = { ...((message.additional_kwargs as Record<string, unknown>) || {}) };
    const rawToolCalls = additionalKwargs.tool_calls;

    if (Array.isArray(rawToolCalls)) {
        const syncedRawToolCalls = rawToolCalls.filter(
            (rawTc: unknown) => keptIds.has(rawToolCallId(rawTc) ?? "")
        );
        if (syncedRawToolCalls.length > 0) {
            additionalKwargs.tool_calls = syncedRawToolCalls;
        } else {
            delete additionalKwargs.tool_calls;
        }
    }

    // 如果没有 tool_calls，移除 function_call
    if (toolCalls.length === 0) {
        delete additionalKwargs.function_call;
    }

    update.additional_kwargs = additionalKwargs;

    // 同步 response_metadata
    const responseMetadata = { ...((message.response_metadata as Record<string, unknown>) || {}) };
    if (toolCalls.length === 0 && responseMetadata.finish_reason === "tool_calls") {
        responseMetadata.finish_reason = "stop";
    }
    update.response_metadata = responseMetadata;

    // 返回克隆的消息
    return { ...message, ...update };
}
