/**
 * 工具搜索 — 运行时延迟工具发现。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/builtins/tool_search.py
 *
 * 包含：
 * - DeferredToolCatalog：不可变、可搜索的延迟工具目录。
 * - buildToolSearchTool：构建 tool_search 工具（闭包 over catalog；通过 Command 记录
 *   提升到 graph state）。
 * - buildDeferredToolSetup：从策略过滤后的工具列表组装目录 + 工具（在策略过滤之后调用）。
 * - buildMcpRoutingMiddleware：从序列化路由元数据构建 PR2 自动提升中间件。
 *
 * Agent 在 <available-deferred-tools> 中看到延迟工具的名称，但直到通过 tool_search
 * 工具获取到完整 schema 后才能调用。延迟集合通过构建时的闭包传递，提升信息存储在
 * 每个线程的 graph state 中——没有 ContextVar。
 */

import { type StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAIFunction } from "@langchain/core/utils/function_calling";
import { ToolMessage } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import { getMcpRouting, isMcpTool } from "../mcp_metadata.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 每次搜索返回的最大工具数。 */
const MAX_RESULTS = 5;

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

function _compileCatalogRegex(pattern: string): RegExp {
    try {
        return new RegExp(pattern, "i");
    } catch {
        return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
}

function _catalogRegexScore(pattern: string, tool: { name: string; description?: string }): number {
    const regex = _compileCatalogRegex(pattern);
    const searchable = `${tool.name} ${tool.description ?? ""}`;
    const matches = searchable.match(regex);
    return matches ? matches.length : 0;
}

// ════════════════════════════════════════════════════════════════════════════════
// DeferredToolCatalog
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 不可变的延迟工具目录。纯搜索，无修改。
 * 对应 Python DeferredToolCatalog (frozen dataclass)。
 */
export class DeferredToolCatalog {
    readonly tools: readonly StructuredToolInterface[];

    constructor(tools: StructuredToolInterface[]) {
        this.tools = Object.freeze([...tools]);
    }

    /** 所有工具的名称集合。对应 Python @cached_property names。 */
    get names(): ReadonlySet<string> {
        return new Set(this.tools.map((t) => t.name));
    }

    /** 目录的 SHA256 哈希（前 16 字符）。对应 Python @cached_property hash。 */
    get hash(): string {
        const canon = [...this.tools]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({ name: t.name, schema: convertToOpenAIFunction(t) }));
        const blob = JSON.stringify(canon, (key, value) =>
            typeof value === "undefined" ? null : value,
        );
        return createHash("sha256").update(blob, "utf-8").digest("hex").slice(0, 16);
    }

    /**
     * 搜索工具。
     *
     * 查询格式：
     * - "select:Read,Edit" — 按名称精确指定工具（无结果上限）
     * - "+slack send" — 名称必须包含 "slack"，按剩余词排序
     * - "notebook jupyter" — 关键词搜索，最多 MAX_RESULTS 个
     */
    search(query: string): StructuredToolInterface[] {
        const q = query.trim();
        if (!q) return [];

        if (q.startsWith("select:")) {
            const wanted = new Set(
                q.slice(7).split(",").map((n) => n.trim()).filter(Boolean),
            );
            return this.tools.filter((t) => wanted.has(t.name));
        }

        if (q.startsWith("+")) {
            const parts = q.slice(1).split(/\s+/, 2);
            if (!parts[0]) return [];
            const required = parts[0].toLowerCase();
            let candidates = this.tools.filter((t) => t.name.toLowerCase().includes(required));
            if (parts.length > 1) {
                candidates = [...candidates].sort(
                    (a, b) => _catalogRegexScore(parts[1], b) - _catalogRegexScore(parts[1], a),
                );
            }
            return candidates.slice(0, MAX_RESULTS);
        }

        const regex = _compileCatalogRegex(q);
        const scored: Array<{ score: number; tool: StructuredToolInterface }> = [];
        for (const t of this.tools) {
            const searchable = `${t.name} ${t.description ?? ""}`;
            if (regex.test(searchable)) {
                const score = regex.test(t.name) ? 2 : 1;
                scored.push({ score, tool: t });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, MAX_RESULTS).map((s) => s.tool);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// DeferredToolSetup
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 为一次 agent 构建组装延迟工具支持的结果。
 * 对应 Python DeferredToolSetup (frozen dataclass)。
 *
 * 三个字段一起移动：
 * - 空（toolSearchTool === null）：延迟被禁用，或没有 MCP 工具通过策略过滤。
 *   工具照常绑定。
 * - 非空：toolSearchTool 追加到 agent 的工具列表中，deferredNames 对模型隐藏，
 *   catalogHash 限定 graph state 中的提升作用域。
 *
 * 不变性：toolSearchTool === null ⟺ deferredNames 为空 ⟺ catalogHash 为 null。
 */
export interface DeferredToolSetup {
    toolSearchTool: StructuredToolInterface | null;
    deferredNames: ReadonlySet<string>;
    catalogHash: string | null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建 tool_search 工具
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 构建 tool_search 工具。
 * 对应 Python build_tool_search_tool。
 *
 * @param catalog 延迟工具目录
 * @returns tool_search 工具
 */
export function buildToolSearchTool(
    catalog: DeferredToolCatalog,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
    const catalogHash = catalog.hash;

    // 使用工具函数定义，通过闭包捕获 catalog 和 catalogHash
    // 对应 Python 中的 @tool 装饰器
    const toolSearchFn = async (
        query: string,
        toolCallId: string,
    ): Promise<Record<string, unknown>> => {
        const matched = catalog.search(query);
        let content: string;
        let names: string[];
        if (matched.length === 0) {
            content = `No tools found matching: ${query}`;
            names = [];
        } else {
            content = JSON.stringify(
                matched.map((t) => convertToOpenAIFunction(t)),
                null,
                2,
            );
            names = matched.map((t) => t.name);
        }

        return {
            promoted: { catalog_hash: catalogHash, names },
            messages: [
                new ToolMessage({
                    content,
                    tool_call_id: toolCallId,
                    name: "tool_search",
                }),
            ],
        };
    };

    // 附加元数据
    toolSearchFn.name = "tool_search";
    toolSearchFn.description =
        "Fetches full schema definitions for deferred tools so they can be called. " +
        "Deferred tools appear by name in <available-deferred-tools> in the system prompt. " +
        'Query forms: "select:Read,Edit" -- fetch exact tools; ' +
        '"notebook jupyter" -- keyword search; ' +
        '"+slack send" -- require "slack" in name, rank by remaining terms.';

    // 定义参数 schema
    toolSearchFn.schema = {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query. Use 'select:Name1,Name2' for exact names, '+required' for required name match, or plain keywords.",
            },
        },
        required: ["query"],
    };

    return toolSearchFn as unknown as StructuredToolInterface;
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建延迟工具设置
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从策略过滤后的工具列表构建延迟工具设置。
 * 必须在 skill/agent 工具策略过滤之后调用，这样目录永远不会暴露当前 agent 无权使用的工具。
 *
 * 对应 Python build_deferred_tool_setup。
 *
 * @param filteredTools 经过策略过滤的工具列表
 * @param enabled 是否启用延迟工具发现
 * @returns 延迟工具设置
 */
export function buildDeferredToolSetup(
    filteredTools: StructuredToolInterface[],
    enabled: boolean,
): DeferredToolSetup {
    if (!enabled) {
        return { toolSearchTool: null, deferredNames: new Set(), catalogHash: null };
    }

    const deferred = filteredTools.filter((t) => isMcpTool(t));
    if (deferred.length === 0) {
        return { toolSearchTool: null, deferredNames: new Set(), catalogHash: null };
    }

    const catalog = new DeferredToolCatalog(deferred);
    return {
        toolSearchTool: buildToolSearchTool(catalog) as unknown as StructuredToolInterface,
        deferredNames: catalog.names,
        catalogHash: catalog.hash,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 组装最终工具列表
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从策略过滤后的工具列表构建最终工具列表 + 延迟工具设置。
 * 必须在工具策略过滤之后调用。
 *
 * Fail-closed：如果 tool_search 启用且有 MCP 工具通过过滤但未恢复延迟集合，
 * 则抛出异常，而不是静默地将完整 schema 绑定给模型。
 *
 * 对应 Python assemble_deferred_tools。
 *
 * @param filteredTools 经过策略过滤的工具列表
 * @param enabled 是否启用延迟工具发现
 * @returns [最终工具列表, 延迟工具设置]
 */
export function assembleDeferredTools(
    filteredTools: StructuredToolInterface[],
    enabled: boolean,
): [StructuredToolInterface[], DeferredToolSetup] {
    const deferredSetup = buildDeferredToolSetup(filteredTools, enabled);

    if (
        enabled &&
        deferredSetup.deferredNames.size === 0 &&
        filteredTools.some((t) => isMcpTool(t))
    ) {
        throw new Error(
            "tool_search enabled and MCP tools survived policy filtering, " +
            "but no deferred set was recovered - refusing to bind MCP schemas (fail-closed).",
        );
    }

    const finalTools = [...filteredTools];
    if (deferredSetup.toolSearchTool) {
        finalTools.push(deferredSetup.toolSearchTool);
    }

    return [finalTools, deferredSetup];
}

// ════════════════════════════════════════════════════════════════════════════════
// MCP 路由中间件构建
// ════════════════════════════════════════════════════════════════════════════════

function _routingPriority(value: unknown): number {
    try {
        return Number(value);
    } catch {
        return 0;
    }
}

function _routingKeywords(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item).trim())
        .filter((kw) => kw.length > 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentMiddleware = any;

/**
 * 从策略过滤后的延迟工具构建 PR2 自动提升中间件。
 *
 * 对应 Python build_mcp_routing_middleware。
 *
 * @param tools 工具列表（用于检查路由元数据）
 * @param deferredSetup 延迟工具设置
 * @param topK 自动提升 top K
 * @returns MCP 路由中间件，或 null 如果不需要
 */
export function buildMcpRoutingMiddleware(
    tools: StructuredToolInterface[],
    deferredSetup: DeferredToolSetup,
    topK: number,
): AgentMiddleware | null {
    if (deferredSetup.catalogHash === null || deferredSetup.deferredNames.size === 0) {
        return null;
    }

    const routingIndex: Record<string, { priority: number; keywords: string[] }> = {};

    for (const candidate of tools) {
        const toolName = candidate.name;
        if (!deferredSetup.deferredNames.has(toolName)) continue;

        const routing = getMcpRouting(candidate);
        if (!routing || routing.mode !== "prefer") continue;

        const keywords = _routingKeywords(routing.keywords);
        if (keywords.length === 0) continue;

        routingIndex[toolName] = {
            priority: _routingPriority(routing.priority ?? 0),
            keywords,
        };
    }

    if (Object.keys(routingIndex).length === 0) {
        return null;
    }

    // McpRoutingMiddleware 由中间件模块提供，这里只构建配置
    // 对应 Python: return McpRoutingMiddleware(routing_index, catalog_hash, top_k)
    return {
        _type: "mcp_routing",
        routingIndex,
        catalogHash: deferredSetup.catalogHash,
        topK,
    } as unknown as AgentMiddleware;
}

// ════════════════════════════════════════════════════════════════════════════════
// Prompt 渲染
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从显式的延迟工具名称集合生成 <available-deferred-tools> 提示段落。
 *
 * 只列出名称，让 agent 知道存在什么工具并使用 tool_search 加载它们。
 * 没有延迟工具时返回空字符串。
 *
 * 对应 Python get_deferred_tools_prompt_section。
 *
 * @param deferredNames 延迟工具名称集合
 * @returns 格式化的提示段落
 */
export function getDeferredToolsPromptSection(
    deferredNames?: ReadonlySet<string>,
): string {
    if (!deferredNames || deferredNames.size === 0) return "";

    const names = [...deferredNames].sort()
        .map((name) => _escapeHtml(name))
        .join("\n");
    return `<available-deferred-tools>\n${names}\n</available-deferred-tools>`;
}

function _formatKeywordList(keywords: string[]): string {
    if (keywords.length === 1) return keywords[0];
    return `${keywords.slice(0, -1).join(", ")}, or ${keywords[keywords.length - 1]}`;
}

/**
 * 从携带路由元数据的 MCP 工具生成 <mcp_routing_hints> 提示段落。
 *
 * 对应 Python get_mcp_routing_hints_prompt_section。
 *
 * @param tools 工具列表
 * @param deferredNames 延迟工具名称集合
 * @returns 格式化的路由提示段落
 */
export function getMcpRoutingHintsPromptSection(
    tools: StructuredToolInterface[],
    deferredNames?: ReadonlySet<string>,
): string {
    const dn = deferredNames ?? new Set<string>();
    const hints: Array<{ priority: number; toolName: string; keywords: string[] }> = [];

    for (const candidate of tools) {
        const routing = getMcpRouting(candidate);
        if (!routing || routing.mode !== "prefer") continue;
        const keywords = _routingKeywords(routing.keywords);
        if (keywords.length === 0) continue;
        hints.push({
            priority: _routingPriority(routing.priority ?? 0),
            toolName: candidate.name,
            keywords: keywords.map((kw) => _escapeHtml(kw)),
        });
    }

    if (hints.length === 0) return "";

    const lines: string[] = ["<mcp_routing_hints>"];
    for (const { priority, toolName, keywords } of hints.sort(
        (a, b) => b.priority - a.priority || a.toolName.localeCompare(b.toolName),
    )) {
        const escName = _escapeHtml(toolName);
        lines.push(`When the user's request involves ${_formatKeywordList(keywords)}:`);
        if (dn.has(toolName)) {
            lines.push(`  use \`tool_search\` to fetch \`${escName}\`, then prefer that MCP tool.`);
        } else {
            lines.push(`  prefer the \`${escName}\` tool.`);
        }
    }
    lines.push("</mcp_routing_hints>");
    return lines.join("\n");
}

/**
 * HTML 转义（仅转义 & < > "，不转义单引号）。
 * 对应 Python html.escape(..., quote=False)。
 */
function _escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
