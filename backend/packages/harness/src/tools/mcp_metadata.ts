/**
 * MCP 工具元数据标记。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/mcp_metadata.py
 *
 * MCP 工具携带 deerflow_mcp 元数据标记。
 * 此模块为"标记"和"判断"的中心，避免 magic string 散落在各处。
 */

export const MCP_TOOL_METADATA_KEY = "deerflow_mcp";
export const MCP_TOOL_ROUTING_METADATA_KEY = "deerflow_mcp_routing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolLike = any;

/**
 * 标记工具为 MCP 来源。
 */
export function tagMcpTool(tool: ToolLike): ToolLike {
    tool.metadata = { ...(tool.metadata || {}), [MCP_TOOL_METADATA_KEY]: true };
    return tool;
}

/**
 * 判断工具是否 MCP 来源。
 */
export function isMcpTool(tool: ToolLike): boolean {
    return (tool.metadata || {})[MCP_TOOL_METADATA_KEY] === true;
}

/**
 * 标记 MCP 路由元数据。
 */
export function tagMcpRouting(tool: ToolLike, routing: Record<string, unknown>): ToolLike {
    tool.metadata = {
        ...(tool.metadata || {}),
        [MCP_TOOL_ROUTING_METADATA_KEY]: { ...routing },
    };
    return tool;
}

/**
 * 获取 MCP 路由元数据。
 */
export function getMcpRouting(tool: ToolLike): Record<string, unknown> | null {
    if (!isMcpTool(tool)) return null;
    const routing = (tool.metadata || {})[MCP_TOOL_ROUTING_METADATA_KEY];
    if (!routing || typeof routing !== "object" || (routing as Record<string, unknown>).mode === "off") {
        return null;
    }
    return routing as Record<string, unknown>;
}
