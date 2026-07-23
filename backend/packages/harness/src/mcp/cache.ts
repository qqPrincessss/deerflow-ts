/**
 * MCP 工具缓存 — 避免重复加载 MCP 工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/mcp/cache.py
 *
 * 功能：
 * - 缓存已加载的 MCP 工具列表
 * - 检测配置文件变更自动失效
 * - 延迟初始化
 */

import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface McpToolInfo {
    name: string;
    description?: string;
    serverName: string;
    parameters?: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════════
// 缓存状态
// ════════════════════════════════════════════════════════════════════════════════

let _cachedTools: McpToolInfo[] | null = null;
let _cacheInitialized = false;
let _configPath: string | null = null;
let _configSignature: [number | null, number | null, string | null] | null = null;

// ════════════════════════════════════════════════════════════════════════════════
// 配置签名
// ════════════════════════════════════════════════════════════════════════════════

function _getConfigSignature(configPath: string): [number | null, number | null, string | null] | null {
    try {
        const stat = statSync(configPath);
        const digest = createHash("sha256");
        const content = readFileSync(configPath);
        digest.update(content);
        return [stat.mtimeMs, stat.size, digest.digest("hex")];
    } catch {
        return null;
    }
}

function _isCacheStale(): boolean {
    if (!_cacheInitialized) return false;
    // 没有配置文件记录 → 不失效
    if (_configSignature === null) return false;

    // 查找当前配置
    const currentPath = process.env.DEER_FLOW_EXTENSIONS_CONFIG
        ?? (process.env.DEER_FLOW_HOME ? `${process.env.DEER_FLOW_HOME}/extensions_config.json` : null)
        ?? ".deer-flow/extensions_config.json";

    if (!existsSync(currentPath)) return false;

    const currentSignature = _getConfigSignature(currentPath);
    if (currentSignature === null) return false;

    if (currentPath !== _configPath) return true;
    if (JSON.stringify(currentSignature) !== JSON.stringify(_configSignature)) return true;

    return false;
}

// ════════════════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 初始化 MCP 工具缓存（应用启动时调用一次）。
 */
export async function initializeMcpTools(
    loader: () => Promise<McpToolInfo[]>,
): Promise<McpToolInfo[]> {
    if (_cacheInitialized) return _cachedTools ?? [];

    _cachedTools = await loader();
    _cacheInitialized = true;
    _configPath = process.env.DEER_FLOW_EXTENSIONS_CONFIG ?? ".deer-flow/extensions_config.json";
    if (existsSync(_configPath)) {
        _configSignature = _getConfigSignature(_configPath);
    }

    return _cachedTools;
}

/**
 * 获取缓存的 MCP 工具（自动延迟初始化）。
 */
export function getCachedMcpTools(loader?: () => Promise<McpToolInfo[]>): McpToolInfo[] | null {
    if (_isCacheStale()) {
        resetMcpToolsCache();
    }
    return _cachedTools;
}

/**
 * 重置 MCP 工具缓存。
 */
export function resetMcpToolsCache(): void {
    _cachedTools = null;
    _cacheInitialized = false;
    _configPath = null;
    _configSignature = null;
}
