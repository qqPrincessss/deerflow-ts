/**
 * MCP 客户端 — MCP 服务器连接配置构建。
 *
 * 对应原项目：backend/packages/harness/deerflow/mcp/client.py
 *
 * 从配置构建 MCP 服务器连接参数，支持 stdio、SSE、HTTP 三种传输方式。
 */

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface McpServerConfig {
    type?: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    oauth?: Record<string, unknown>;
    enabled?: boolean;
    [key: string]: unknown;
}

export interface McpServerParams {
    transport: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建服务器参数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从配置构建单个 MCP 服务器的连接参数。
 */
export function buildServerParams(serverName: string, config: McpServerConfig): McpServerParams {
    const transportType = config.type ?? "stdio";
    const params: McpServerParams = { transport: transportType };

    if (transportType === "stdio") {
        if (!config.command) {
            throw new Error(`MCP server '${serverName}' with stdio transport requires 'command' field`);
        }
        params.command = config.command;
        params.args = config.args;
        if (config.env) params.env = config.env;
    } else if (transportType === "sse" || transportType === "http") {
        if (!config.url) {
            throw new Error(`MCP server '${serverName}' with ${transportType} transport requires 'url' field`);
        }
        params.url = config.url;
        if (config.headers) params.headers = config.headers;
    } else {
        throw new Error(`MCP server '${serverName}' has unsupported transport type: ${transportType}`);
    }

    return params;
}

/**
 * 从扩展配置构建所有启用 MCP 服务器的连接参数。
 */
export function buildServersConfig(
    enabledServers: Record<string, McpServerConfig>,
): Record<string, McpServerParams> {
    if (!enabledServers || Object.keys(enabledServers).length === 0) return {};

    const configs: Record<string, McpServerParams> = {};
    for (const [name, serverConfig] of Object.entries(enabledServers)) {
        try {
            configs[name] = buildServerParams(name, serverConfig);
        } catch (error) {
            console.error(`Failed to configure MCP server '${name}':`, error);
        }
    }
    return configs;
}
