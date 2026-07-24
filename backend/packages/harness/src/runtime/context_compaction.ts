/**
 * 上下文压缩 — 手动压缩线程对话。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/context_compaction.py
 *
 * 将线程中旧消息压缩为摘要，保留最近的消息。
 * 提供手动 compaction 能力（非自动 summarization middleware 触发）。
 */

import { createHash } from "node:crypto";
import { compactContext, type SummarizationConfig } from "../agents/middlewares/summarization.js";
import { type AppConfig } from "../config/app_config.js";
import { getAppConfig } from "../config/app_config.js";
import { createChatModel } from "../models/factory.js";

// ════════════════════════════════════════════════════════════════════════════════
// 异常
// ════════════════════════════════════════════════════════════════════════════════

/** 当手动 compaction 请求时 summarization 被禁用。 */
export class ContextCompactionDisabled extends Error {
    constructor() { super("Context compaction is disabled."); }
}

/** 当可压缩线程无法被 summarization 时抛出。 */
export class ContextCompactionFailed extends Error {
    constructor(msg: string) { super(msg); }
}

// ════════════════════════════════════════════════════════════════════════════════
// 结果
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 手动 context compaction 的结果。
 * 对应 Python ThreadCompactionResult (dataclass)。
 */
export interface ThreadCompactionResult {
    thread_id: string;
    compacted: boolean;
    reason?: string | null;
    removed_message_count?: number;
    preserved_message_count?: number;
    summary_updated?: boolean;
    /** 新 checkpoint 的 ID（基于 summaries 的 sha256 派生）。 */
    checkpoint_id?: string | null;
    total_tokens?: number;
    /** 摘要文本的 sha256 哈希。 */
    summary_sha256?: string;
    /** 摘要文本的字符数。 */
    summary_chars?: number;
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 创建 compaction 使用的 summarization middleware。
 * 对应 Python _create_compaction_middleware。
 *
 * 如果 summarization 被禁用，抛出 ContextCompactionDisabled。
 */
function _createCompactionMiddleware(
    summarizationConfig?: SummarizationConfig,
): SummarizationConfig | null {
    if (!summarizationConfig || summarizationConfig.enabled === false) {
        return null;
    }
    return summarizationConfig;
}

/**
 * 从 checkpoint 配置中提取 namespace。
 * 对应 Python _checkpoint_namespace。
 *
 * 在 TS 版中简化处理 —— 仅用于记录用途。
 */
export function checkpointNamespace(checkpointTuple?: Record<string, unknown> | null): string {
    if (!checkpointTuple) return "";
    const config = checkpointTuple.config as Record<string, unknown> | undefined;
    if (!config) return "";
    const configurable = config.configurable as Record<string, unknown> | undefined;
    if (!configurable) return "";
    const ns = configurable.checkpoint_ns;
    return typeof ns === "string" ? ns : "";
}

// ════════════════════════════════════════════════════════════════════════════════
// 压缩函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 压缩线程上下文 — 将旧消息摘要化，保留最近消息。
 *
 * 对应 Python compact_thread_context，但 TS 版不依赖 LangGraph checkpointer，
 * 直接接收消息数组并返回结果。
 *
 * @param messages 消息列表
 * @param threadId 线程 ID
 * @param options.summarizationConfig summarization 配置
 * @param options.appConfig 应用配置（备选）
 * @param options.force 是否强制压缩（默认 true）
 */
export async function compactThreadContext(
    messages: Array<Record<string, unknown>>,
    threadId: string,
    options?: {
        summarizationConfig?: SummarizationConfig;
        appConfig?: AppConfig | null;
        force?: boolean;
    },
): Promise<ThreadCompactionResult> {
    const resolvedConfig = options?.appConfig ?? getAppConfig();

    const summarizationConfig = options?.summarizationConfig ??
        (resolvedConfig as Record<string, unknown>).summarization as SummarizationConfig | undefined;

    const middleware = _createCompactionMiddleware(summarizationConfig);
    if (!middleware) {
        throw new ContextCompactionDisabled();
    }

    if (!Array.isArray(messages) || messages.length === 0) {
        return { thread_id: threadId, compacted: false, reason: "not_enough_messages" };
    }

    // 创建摘要 LLM
    const modelName = middleware.model_name;
    const model = modelName ? await createChatModel(modelName) : await createChatModel();

    const result = await compactContext(
        messages,
        async (prompt: string) => {
            const response = await model.invoke([
                { type: "human", content: prompt },
            ]);
            const text = typeof response.content === "string"
                ? response.content
                : JSON.stringify(response.content);
            return text || null;
        },
        summarizationConfig,
    );

    if (!result) {
        return { thread_id: threadId, compacted: false, reason: "not_enough_messages" };
    }

    // 计算摘要的 sha256（与 Python 原项目一致）
    const summaryText = result.summary_text ?? "";
    const sha256 = summaryText ? createHash("sha256").update(summaryText, "utf-8").digest("hex") : "";

    return {
        thread_id: threadId,
        compacted: true,
        reason: null,
        removed_message_count: result.messages_to_summarize?.length ?? 0,
        preserved_message_count: result.preserved_messages.length,
        summary_updated: true,
        checkpoint_id: sha256 ? `cmp_${sha256.slice(0, 12)}` : null,
        total_tokens: result.total_tokens,
        summary_sha256: sha256 || undefined,
        summary_chars: summaryText.length || undefined,
    };
}
