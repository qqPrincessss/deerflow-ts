/**
 * MCP 路由中间件 — 根据用户输入关键词自动提升延迟加载的 MCP 工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/mcp_routing_middleware.py
 *
 * 流程：
 *   1. Agent 构建时，从 MCP 工具的 description 中提取关键词和优先级，构建路由索引
 *   2. 每次模型调用前，检查用户最新消息是否包含路由索引中的关键词
 *   3. 匹配到的工具名写入 state.promoted.names
 *   4. DeferredToolFilterMiddleware 根据 promoted 列表放行这些工具
 */

import { clampAutoPromoteTopK } from "../../config/tool_search_config.js";
import { getOriginalUserContentText, isRealUserMessage } from "../../utils/messages.js";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface McpRoutingIndexEntry {
    priority: number;
    keywords: string[];
}

export type McpRoutingIndex = Record<string, McpRoutingIndexEntry>;

/** 规范化后的路由索引 */
type NormalizedIndex = Record<string, [number, string[]]>;

// ════════════════════════════════════════════════════════════════════════════════
// 路由索引规范化
// ════════════════════════════════════════════════════════════════════════════════

function _normalizeIndex(routingIndex: McpRoutingIndex): NormalizedIndex {
    const normalized: NormalizedIndex = {};

    for (const [name, entry] of Object.entries(routingIndex)) {
        if (!name) continue;

        let priority = 0;
        try {
            priority = Math.max(0, Math.floor(Number(entry.priority) || 0));
        } catch { /* 用默认值 0 */ }

        const rawKeywords = entry.keywords ?? [];
        if (!Array.isArray(rawKeywords)) continue;

        const keywords = rawKeywords
            .map((k) => String(k).trim())
            .filter(Boolean);

        if (keywords.length === 0) continue;

        normalized[name] = [priority, keywords];
    }

    return normalized;
}

// ════════════════════════════════════════════════════════════════════════════════
// 关键词匹配
// ════════════════════════════════════════════════════════════════════════════════

function _getLatestUserMessage(messages: Array<Record<string, unknown>>): Record<string, unknown> | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isRealUserMessage(messages[i])) return messages[i];
    }
    return null;
}

function _matchedNames(
    messages: Array<Record<string, unknown>>,
    routingIndex: NormalizedIndex,
    catalogHash: string | null,
    topK: number,
): string[] {
    if (!catalogHash || Object.keys(routingIndex).length === 0) return [];

    const target = _getLatestUserMessage(messages);
    if (!target) return [];

    const text = getOriginalUserContentText(
        target.content as string | unknown[],
        target.additional_kwargs as Record<string, unknown> | undefined,
    );
    if (!text) return [];

    const haystack = text.toLowerCase();
    const matched: Array<[number, string]> = [];

    for (const [name, [priority, keywords]] of Object.entries(routingIndex)) {
        if (keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
            matched.push([priority, name]);
        }
    }

    if (matched.length === 0) return [];

    // 按优先级降序、同名按字母序
    matched.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    return matched.slice(0, Math.max(1, topK)).map(([, name]) => name);
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 构建 MCP 路由中间件。
 *
 * @param routingIndex 路由索引（工具名 → { priority, keywords }）
 * @param catalogHash 目录哈希
 * @param topK 最大提升数量
 * @returns { beforeModel } 函数
 */
export function createMcpRoutingMiddleware(
    routingIndex: McpRoutingIndex,
    catalogHash: string | null,
    topK: number,
): {
    beforeModel(state: Record<string, unknown>): Record<string, unknown> | null;
    abeforeModel(state: Record<string, unknown>): Promise<Record<string, unknown> | null>;
} {
    const normalized = _normalizeIndex(routingIndex);
    const effectiveTopK = clampAutoPromoteTopK(topK);

    function beforeModel(state: Record<string, unknown>): Record<string, unknown> | null {
        const messages = (state.messages as Array<Record<string, unknown>>) ?? [];
        const names = _matchedNames(messages, normalized, catalogHash, effectiveTopK);
        if (names.length === 0) return null;

        return {
            promoted: {
                catalog_hash: catalogHash,
                names,
            },
        };
    }

    async function abeforeModel(state: Record<string, unknown>): Promise<Record<string, unknown> | null> {
        return beforeModel(state);
    }

    return { beforeModel, abeforeModel };
}

/**
 * 断言 MCP 路由中间件在延迟工具过滤中间件之前。
 * 如果顺序不对，运行时抛错。
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
