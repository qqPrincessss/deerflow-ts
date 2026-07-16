/**
 * 工具结果元数据 — 统一的工具结果语义。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/tool_result_meta.py
 *
 * 每个工具结果都带一个 deerflow_tool_meta 标签，告诉下游：
 * - 这个结果是成功还是失败？
 * - 如果失败了，是什么类型的错误？
 * - LLM 能不能自己恢复？
 * - 建议 LLM 下一步做什么？
 */

// ─── 常量 ──────────────────────────────────────────────────

/** 元数据 key */
export const TOOL_META_KEY = "deerflow_tool_meta";

/** 错误前缀 */
const ERROR_PREFIX = "Error:";

/** 部分成功的关键词 */
const PARTIAL_MARKERS = [
    "partial results",
    "limited results",
    "truncated",
    "results may be incomplete",
    "no results found",
    "no content found",
    "no images found",
];

/** 语义零错误字符串（表示"没有错误"） */
const SEMANTIC_ZERO_ERROR_STRINGS = new Set(["none", "null", "false", "no", "ok", "success", "n/a", ""]);

// ─── 类型定义 ──────────────────────────────────────────────────

/** 工具结果元数据 */
export interface ToolResultMeta {
    status: "success" | "error" | "partial_success";
    error_type: string | null;
    recoverable_by_model: boolean;
    recommended_next_action: "continue" | "rewrite_query" | "try_alternative" | "summarize" | "stop";
    source: "exception" | "tool_return" | "content_analysis" | "progress_middleware";
}

// ─── 错误分类规则 ──────────────────────────────────────────────────

/** 错误规则：关键词列表 → 属性 */
const ERROR_RULES: Array<{ keywords: string[]; attrs: Partial<ToolResultMeta> }> = [
    {
        keywords: ["401", "403", "unauthorized", "authentication", "invalid api key"],
        attrs: { error_type: "auth", recoverable_by_model: false, recommended_next_action: "stop" },
    },
    {
        keywords: ["rate limit", "rate limited", "rate_limit"],
        attrs: { error_type: "rate_limited", recoverable_by_model: false, recommended_next_action: "summarize" },
    },
    {
        keywords: ["timeout", "timed out", "connection", "network error", "temporarily unavailable"],
        attrs: { error_type: "transient", recoverable_by_model: false, recommended_next_action: "try_alternative" },
    },
    {
        keywords: ["not configured", "not installed", "missing required", "disabled", "no api key"],
        attrs: { error_type: "config", recoverable_by_model: false, recommended_next_action: "stop" },
    },
    {
        keywords: ["permission denied", "access denied", "path traversal", "forbidden"],
        attrs: { error_type: "permission", recoverable_by_model: true, recommended_next_action: "try_alternative" },
    },
    {
        keywords: ["no results found", "no content found", "no images found", "no results"],
        attrs: { error_type: "no_results", recoverable_by_model: true, recommended_next_action: "rewrite_query" },
    },
    {
        keywords: ["not found", "no such file", "does not exist", "404"],
        attrs: { error_type: "not_found", recoverable_by_model: true, recommended_next_action: "rewrite_query" },
    },
    {
        keywords: ["unexpected error", "internal error", "500"],
        attrs: { error_type: "internal", recoverable_by_model: false, recommended_next_action: "stop" },
    },
];

/** 未知错误默认值 */
const UNKNOWN_ERROR: Partial<ToolResultMeta> = {
    error_type: "unknown",
    recoverable_by_model: true,
    recommended_next_action: "try_alternative",
};

/** 数字关键词的正则表达式（预编译） */
const NUMERIC_KW_RE: Record<string, RegExp> = {};
for (const rule of ERROR_RULES) {
    for (const kw of rule.keywords) {
        if (/^\d+$/.test(kw)) {
            NUMERIC_KW_RE[kw] = new RegExp(`\\b${kw}\\b`);
        }
    }
}

// ─── 内部函数 ──────────────────────────────────────────────────

/**
 * 从 JSON 错误中提取错误文本。
 *
 * 处理 {"error": "...", "query": "..."} 这种格式。
 * 如果 error 字段是 "none"、"null" 等，返回 null（表示没有错误）。
 */
function extractJsonErrorText(content: string): string | null {
    let data: unknown;
    try {
        data = JSON.parse(content);
    } catch {
        return null;
    }

    if (typeof data !== "object" || data === null) {
        return null;
    }

    const error = (data as Record<string, unknown>).error;
    if (!error) {
        return null;
    }

    if (typeof error === "string" && SEMANTIC_ZERO_ERROR_STRINGS.has(error.toLowerCase().trim())) {
        return null;
    }

    return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * 匹配关键词（数字用词边界匹配）。
 */
function matchKeyword(kw: string, lower: string): boolean {
    if (/^\d+$/.test(kw)) {
        const re = NUMERIC_KW_RE[kw];
        return re ? re.test(lower) : false;
    }
    return lower.includes(kw);
}

/**
 * 分析错误文本，返回错误属性。
 */
function classifyErrorText(text: string): Partial<ToolResultMeta> {
    const lower = text.toLowerCase();
    for (const rule of ERROR_RULES) {
        if (rule.keywords.some((kw) => matchKeyword(kw, lower))) {
            return { ...rule.attrs };
        }
    }
    return { ...UNKNOWN_ERROR };
}

/**
 * 创建元数据对象。
 */
function makeMeta(options: {
    status: string;
    source: string;
    error_type?: string | null;
    recoverable_by_model?: boolean;
    recommended_next_action?: string;
}): ToolResultMeta {
    return {
        status: options.status as ToolResultMeta["status"],
        error_type: options.error_type ?? null,
        recoverable_by_model: options.recoverable_by_model ?? true,
        recommended_next_action: (options.recommended_next_action ?? "continue") as ToolResultMeta["recommended_next_action"],
        source: options.source as ToolResultMeta["source"],
    };
}

// ─── 导出函数 ──────────────────────────────────────────────────

/**
 * 给异常结果打标签。
 *
 * 对应原项目 stamp_exception_meta。
 * 总是覆盖已有的标签（异常分类比工具自己的分类更权威）。
 */
export function stampExceptionMeta(
    msg: { additional_kwargs?: Record<string, unknown> },
    excInfo: string
): void {
    const attrs = classifyErrorText(excInfo);
    const updatedKwargs = { ...(msg.additional_kwargs || {}) };
    updatedKwargs[TOOL_META_KEY] = makeMeta({ status: "error", source: "exception", ...attrs });
    msg.additional_kwargs = updatedKwargs;
}

/**
 * 给正常结果打标签。
 *
 * 对应原项目 normalize_tool_message。
 * 如果已有标签，不覆盖。
 */
export function normalizeToolMessage(
    msg: { content: string | unknown; status?: string; additional_kwargs?: Record<string, unknown> }
): void {
    const existing = (msg.additional_kwargs || {})[TOOL_META_KEY];
    if (existing !== undefined) {
        return;
    }

    const content = typeof msg.content === "string" ? msg.content : "";
    const contentLower = content.toLowerCase();

    let meta: ToolResultMeta;

    // 非标准错误：status="error" 但没有 "Error:" 前缀
    if (msg.status === "error" && !content.startsWith(ERROR_PREFIX)) {
        const jsonError = extractJsonErrorText(content);
        if (jsonError !== null) {
            const attrs = classifyErrorText(jsonError);
            meta = makeMeta({ status: "error", source: "tool_return", ...attrs });
        } else {
            // 检查是否是 JSON 对象（没有 error 字段）
            let isJsonDict = false;
            try {
                isJsonDict = typeof JSON.parse(content) === "object";
            } catch {
                // 不是 JSON
            }
            const attrs = isJsonDict ? { ...UNKNOWN_ERROR } : classifyErrorText(content);
            meta = makeMeta({ status: "error", source: "tool_return", ...attrs });
        }
    }
    // 标准错误：以 "Error:" 开头
    else if (content.startsWith(ERROR_PREFIX)) {
        const attrs = classifyErrorText(content.slice(ERROR_PREFIX.length));
        meta = makeMeta({ status: "error", source: "tool_return", ...attrs });
    }
    // JSON 包装的错误
    else {
        const jsonError = extractJsonErrorText(content);
        if (jsonError !== null) {
            const attrs = classifyErrorText(jsonError);
            meta = makeMeta({ status: "error", source: "tool_return", ...attrs });
        }
        // 部分成功
        else if (PARTIAL_MARKERS.some((m) => contentLower.includes(m))) {
            meta = makeMeta({
                status: "partial_success",
                source: "content_analysis",
                recommended_next_action: "rewrite_query",
            });
        }
        // 成功
        else {
            meta = makeMeta({ status: "success", source: "content_analysis" });
        }
    }

    const updatedKwargs = { ...(msg.additional_kwargs || {}) };
    updatedKwargs[TOOL_META_KEY] = meta;
    msg.additional_kwargs = updatedKwargs;
}

/**
 * 标准化工具结果（处理 Command 包装）。
 *
 * 对应原项目 normalize_tool_result。
 */
export function normalizeToolResult(result: unknown): unknown {
    if (result && typeof result === "object" && "content" in result) {
        normalizeToolMessage(result as { content: string; status?: string; additional_kwargs?: Record<string, unknown> });
    }
    return result;
}
