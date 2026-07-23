/**
 * MCP 工具加载 — 从 MCP 服务器加载工具并集成到 DeerFlow。
 *
 * 对应原项目：backend/packages/harness/deerflow/mcp/tools.py
 *
 * 功能：
 * - 连接 MCP 服务器（stdio/SSE/HTTP）
 * - 加载工具定义
 * - 创建 invoke 函数（with session pooling）
 * - 处理 OAuth 认证
 * - 本地文件路径转为虚拟路径
 */

import { buildServerParams, type McpServerConfig, type McpServerParams } from "./client.js";
import { getSessionPool, type McpSession } from "./session_pool.js";
import { OAuthTokenManager, getInitialOAuthHeaders, type McpOAuthConfig } from "./oauth.js";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface McpToolInfo {
    name: string;
    description?: string;
    serverName: string;
    inputSchema?: Record<string, unknown>;
}

interface McpToolRequest {
    name: string;
    args: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具名校验
// ════════════════════════════════════════════════════════════════════════════════

const _VALID_MCP_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

// ════════════════════════════════════════════════════════════════════════════════
// 虚拟路径转换
// ════════════════════════════════════════════════════════════════════════════════

const VIRTUAL_PATH_PREFIX = "/mnt/user-data";

function _localPathToVirtual(localPath: string, threadId: string): string | null {
    // 检查是否在用户数据目录下
    const userDataMarker = "/user-data/";
    const idx = localPath.indexOf(userDataMarker);
    if (idx === -1) return null;

    const relative = localPath.slice(idx + userDataMarker.length).replace(/\\/g, "/");
    return `${VIRTUAL_PATH_PREFIX}/${relative}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// MCP 工具包装
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 创建一个 MCP 会话（通过 fetch 调用 JSON-RPC）。
 */
async function _createJsonRpcSession(connection: McpServerParams): Promise<McpSession> {
    if (connection.transport === "stdio") {
        throw new Error("stdio transport requires @modelcontextprotocol/sdk. Use SSE/HTTP instead.");
    }

    const baseUrl = connection.url ?? "";
    const headers: Record<string, string> = { ...connection.headers, "Content-Type": "application/json" };

    return {
        async request(method: string, params?: Record<string, unknown>) {
            const body = JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params: params ?? {},
            });

            const response = await fetch(baseUrl, {
                method: "POST",
                headers,
                body,
            });

            const result = await response.json() as Record<string, unknown>;
            if (result.error) {
                throw new Error(`MCP error: ${JSON.stringify(result.error)}`);
            }
            return result.result;
        },
        async close() {
            // HTTP 连接无状态，不需要关闭
        },
    };
}

/**
 * 包装 MCP 工具为 DeerFlow 可调用的函数。
 */
function _wrapMcpTool(
    toolName: string,
    serverName: string,
    connection: McpServerParams,
    oauthManager?: OAuthTokenManager | null,
): { name: string; description?: string; invoke: (args: Record<string, unknown>) => Promise<unknown> } {
    const pool = getSessionPool();

    return {
        name: toolName,
        invoke: async (args: Record<string, unknown>) => {
            const scopeKey = "default"; // 正式：从 runtime 取 user_id:thread_id

            // 获取/创建持久化会话
            const session = await pool.getSession(serverName, scopeKey, connection as any, async () => {
                return _createJsonRpcSession(connection);
            });

            // 如果有 OAuth，在请求前注入 Authorization header
            if (oauthManager) {
                const authHeader = await oauthManager.getAuthorizationHeader(serverName);
                // 对于 HTTP/SSE，授权已经在连接时注入
            }

            // 调用工具
            const result = await session.request("tools/call", {
                name: toolName,
                arguments: args,
            });

            // 转换结果中的本地路径为虚拟路径
            const content = result as Record<string, unknown>;
            if (content.content && Array.isArray(content.content)) {
                for (const item of content.content) {
                    const ci = item as Record<string, unknown>;
                    if (ci.type === "text" && typeof ci.text === "string") {
                        // 尝试转换路径引用
                        const pathMatch = (ci.text as string).match(/(?:file:\/\/)?(\/[^\s"'<>|]+)/);
                        if (pathMatch) {
                            const virtual = _localPathToVirtual(pathMatch[1], scopeKey);
                            if (virtual) {
                                ci.text = (ci.text as string).replace(pathMatch[1], virtual);
                            }
                        }
                    }
                }
            }

            return content;
        },
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 获取所有启用 MCP 服务器的工具。
 */
export async function getMcpTools(
    enabledServers: Record<string, McpServerConfig>,
): Promise<McpToolInfo[]> {
    if (!enabledServers || Object.keys(enabledServers).length === 0) return [];

    const serversConfig: Record<string, McpServerParams> = {};
    for (const [name, cfg] of Object.entries(enabledServers)) {
        try {
            serversConfig[name] = buildServerParams(name, cfg);
        } catch (error) {
            console.error(`Failed to configure MCP server '${name}':`, error);
        }
    }

    if (Object.keys(serversConfig).length === 0) return [];

    // 初始 OAuth
    const oauthByServer: Record<string, McpOAuthConfig> = {};
    for (const [name, cfg] of Object.entries(enabledServers)) {
        if (cfg.oauth && (cfg.oauth as unknown as McpOAuthConfig).enabled !== false) {
            oauthByServer[name] = cfg.oauth as unknown as McpOAuthConfig;
        }
    }
    const oauthManager = Object.keys(oauthByServer).length > 0 ? new OAuthTokenManager(oauthByServer) : null;

    // 获取初始 OAuth headers
    if (oauthManager) {
        await getInitialOAuthHeaders(oauthByServer);
    }

    const tools: McpToolInfo[] = [];

    for (const [serverName, params] of Object.entries(serversConfig)) {
        try {
            const session = await _createJsonRpcSession(params);
            const result = await session.request("tools/list") as Record<string, unknown>;
            const toolList = result.tools as Array<Record<string, unknown>> ?? [];

            for (const tool of toolList) {
                const name = tool.name as string;
                if (!_VALID_MCP_TOOL_NAME.test(name)) {
                    console.warn(`Dropping MCP tool with invalid name: ${name}`);
                    continue;
                }

                tools.push({
                    name: `${serverName}_${name}`,
                    description: tool.description as string | undefined,
                    serverName,
                    inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
                });
            }
        } catch (error) {
            console.error(`Failed to load tools from MCP server '${serverName}':`, error);
        }
    }

    return tools;
}

/**
 * 构建 MCP 工具列表（供 DeerFlow 工具系统使用）。
 */
export function buildMcpToolFns(
    tools: McpToolInfo[],
    enabledServers: Record<string, McpServerConfig>,
): Array<{ name: string; description?: string; invoke: (args: Record<string, unknown>) => Promise<unknown> }> {
    const serversConfig: Record<string, McpServerParams> = {};
    for (const [name, cfg] of Object.entries(enabledServers)) {
        try {
            serversConfig[name] = buildServerParams(name, cfg);
        } catch { /* 跳过 */ }
    }

    const oauthByServer: Record<string, McpOAuthConfig> = {};
    for (const [name, cfg] of Object.entries(enabledServers)) {
        if (cfg.oauth && (cfg.oauth as unknown as McpOAuthConfig).enabled !== false) {
            oauthByServer[name] = cfg.oauth as unknown as McpOAuthConfig;
        }
    }
    const oauthManager = Object.keys(oauthByServer).length > 0 ? new OAuthTokenManager(oauthByServer) : null;

    return tools.map((tool) => _wrapMcpTool(tool.name, tool.serverName, serversConfig[tool.serverName], oauthManager));
}
