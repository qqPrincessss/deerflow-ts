/**
 * 上下文压缩 — 手动压缩线程对话。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/context_compaction.py
 *
 * 将线程中旧消息压缩为摘要，保留最近的消息。
 */

import { compactContext, buildSummaryMessage, type SummarizationConfig } from "../agents/middlewares/summarization.js";
import { type AppConfig } from "../config/app_config.js";
import { getAppConfig } from "../config/app_config.js";
import { createChatModel } from "../models/factory.js";

// ════════════════════════════════════════════════════════════════════════════════
// 异常
// ════════════════════════════════════════════════════════════════════════════════

export class ContextCompactionDisabled extends Error {
    constructor() { super("Context compaction is disabled."); }
}

export class ContextCompactionFailed extends Error {
    constructor(msg: string) { super(msg); }
}

// ════════════════════════════════════════════════════════════════════════════════
// 结果
// ════════════════════════════════════════════════════════════════════════════════

export interface ThreadCompactionResult {
    thread_id: string;
    compacted: boolean;
    reason?: string | null;
    removed_message_count?: number;
    preserved_message_count?: number;
    summary_updated?: boolean;
    total_tokens?: number;
}

// ════════════════════════════════════════════════════════════════════════════════
// 压缩函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 压缩线程上下文。
 *
 * @param messages 消息列表
 * @param threadId 线程 ID
 * @param options 选项
 * @returns 压缩结果
 */
export async function compactThreadContext(
    messages: Array<Record<string, unknown>>,
    threadId: string,
    options?: {
        summarizationConfig?: SummarizationConfig;
        appConfig?: AppConfig | null;
    },
): Promise<ThreadCompactionResult> {
    const resolvedConfig = options?.appConfig ?? getAppConfig();

    // 摘要 LLM
    const summarizationConfig = options?.summarizationConfig ?? (resolvedConfig as Record<string, unknown>).summarization as SummarizationConfig | undefined;
    if (summarizationConfig?.enabled === false) {
        throw new ContextCompactionDisabled();
    }

    const modelName = (summarizationConfig as Record<string, unknown> | undefined)?.model_name as string | undefined;
    const model = modelName ? await createChatModel(modelName) : await createChatModel();

    const result = await compactContext(
        messages,
        async (prompt) => {
            const response = await model.invoke([
                { type: "human", content: prompt },
            ]);
            const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
            return text || null;
        },
        summarizationConfig,
    );

    if (!result) {
        return { thread_id: threadId, compacted: false, reason: "not_enough_messages" };
    }

    return {
        thread_id: threadId,
        compacted: true,
        removed_message_count: messages.length - result.preserved_messages.length,
        preserved_message_count: result.preserved_messages.length,
        summary_updated: true,
        total_tokens: 0,
    };
}
