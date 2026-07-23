/**
 * 延迟工具过滤中间件 — 隐藏未提拔的 MCP 工具 schema。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/deferred_tool_filter_middleware.py
 *
 * MCP 工具默认不暴露给 LLM（省 Token）。
 * 只有在 tool_search 发现或被 mcp_routing 提拔后，才暴露给 LLM。
 * 但所有工具仍然在 ToolNode 中，可以执行——只是 LLM 看不到 schema。
 *
 * 两件事：
 *   1. wrap_model_call：从 LLM 的工具列表中移除未提拔的工具
 *   2. wrap_tool_call：拦截对未提拔工具的调用，返回错误消息
 */

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 创建延迟工具过滤中间件。
 *
 * @param deferredNames 延迟加载的工具名集合
 * @param catalogHash 目录哈希
 * @returns { filterTools, blockToolCall, ablockToolCall, assertOrder }
 */
export function createDeferredToolFilter(
    deferredNames: Set<string>,
    catalogHash: string | null,
) {
    function _promoted(state?: Record<string, unknown> | null): Set<string> {
        if (!state) return new Set();
        const promoted = state.promoted as Record<string, unknown> | undefined;
        if (promoted && promoted.catalog_hash === catalogHash) {
            const names = promoted.names as string[] | undefined;
            return new Set(names ?? []);
        }
        return new Set();
    }

    function _hidden(state?: Record<string, unknown> | null): Set<string> {
        const promoted = _promoted(state);
        const hidden = new Set<string>();
        for (const name of deferredNames) {
            if (!promoted.has(name)) hidden.add(name);
        }
        return hidden;
    }

    /** 从模型请求的工具列表中移除未提拔的工具（同步） */
    function filterTools(tools: string[], state?: Record<string, unknown> | null): string[] {
        if (deferredNames.size === 0) return tools;
        const hide = _hidden(state);
        if (hide.size === 0) return tools;
        return tools.filter((t) => !hide.has(t));
    }

    /** 检查工具调用是否被拦截，返回错误消息或 null（同步） */
    function blockToolCall(
        toolName: string,
        state?: Record<string, unknown> | null,
        toolCallId?: string,
    ): Record<string, unknown> | null {
        if (deferredNames.size === 0) return null;
        if (!toolName || !_hidden(state).has(toolName)) return null;

        return {
            type: "tool",
            content: `Error: Tool '${toolName}' is deferred and has not been promoted yet. Call tool_search first to expose and promote this tool's schema, then retry.`,
            tool_call_id: toolCallId ?? "missing_tool_call_id",
            name: toolName,
            status: "error",
        };
    }

    /** 检查工具调用是否被拦截（异步） */
    async function ablockToolCall(
        toolName: string,
        state?: Record<string, unknown> | null,
        toolCallId?: string,
    ): Promise<Record<string, unknown> | null> {
        return blockToolCall(toolName, state, toolCallId);
    }

    return { filterTools, blockToolCall, ablockToolCall };
}

/**
 * 断言 MCP 路由中间件在延迟工具过滤中间件之前。
 */
export function assertMcpRoutingBeforeDeferredFilter(
    middlewareList: string[],
): void {
    const routingIdx = middlewareList.indexOf("mcp_routing");
    const filterIdx = middlewareList.indexOf("deferred_tool_filter");
    if (routingIdx !== -1 && filterIdx !== -1 && routingIdx > filterIdx) {
        throw new Error(
            `McpRoutingMiddleware must be installed before DeferredToolFilterMiddleware ` +
            `(routing index ${routingIdx}, deferred filter index ${filterIdx})`,
        );
    }
}
