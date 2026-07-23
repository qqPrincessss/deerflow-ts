/**
 * 上下文压缩中间件 — 对话太长时压缩中间内容为摘要。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py
 *
 * 流程：
 *   1. 检查消息数/Token 数是否超过触发阈值
 *   2. 确定截断位置（保留头 N 条 + 尾 M 条）
 *   3. 把中间部分格式化为 prompt，调 LLM 生成摘要
 *   4. 保留动态上下文提醒（日期、记忆）不被压缩
 *   5. 用 RemoveMessage 替换消息列表，摘要存 summary_text
 *   6. 触发 before_summarization hooks（如记忆刷新）
 */

import { type AppConfig } from "../../config/app_config.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _SUMMARY_TRIGGER_MESSAGE_NAME = "summary";
const _DYNAMIC_CONTEXT_REMINDER_KEY = "dynamic_context_reminder";

/** 默认触发条件 */
const _DEFAULT_TRIGGER_MESSAGE_COUNT = 50;
const _DEFAULT_TRIGGER_TOKEN_COUNT = 100_000;

/** 默认保留消息数 */
const _DEFAULT_KEEP_FIRST_N = 10;
const _DEFAULT_KEEP_LAST_N = 20;

/** 默认 trim_tokens_to_summarize（压缩 prompt 的 Token 上限） */
const _DEFAULT_TRIM_TOKENS_TO_SUMMARIZE = 4096;

/** 摘要字符上限 */
const _SUMMARY_CHAR_BUDGET = 6000;

/** 默认摘要 prompt */
const _DEFAULT_SUMMARY_PROMPT = `You are a conversation summarization assistant. Your task is to concisely summarize the key information from the following conversation messages.

<messages>
{messages}
</messages>

Provide a concise summary of the key points, decisions, and findings from these messages. Focus on information that would be needed to continue the conversation coherently.`;

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface SummarizationConfig {
    enabled?: boolean;
    trigger_message_count?: number;
    trigger_token_count?: number;
    keep_first_n?: number;
    keep_last_n?: number;
    trim_tokens_to_summarize?: number;
    summary_prompt?: string;
    model_name?: string;
}

/**
 * 压缩结果。
 */
export interface ContextCompactionResult {
    summary_text: string;
    messages_to_summarize: Array<Record<string, unknown>>;
    preserved_messages: Array<Record<string, unknown>>;
    total_tokens: number;
}

/**
 * 压缩前 hook 事件。
 */
export interface SummarizationEvent {
    messages_to_summarize: Array<Record<string, unknown>>;
    preserved_messages: Array<Record<string, unknown>>;
    thread_id: string | null;
    agent_name: string | null;
}

/** 压缩前 hook 类型 */
export type BeforeSummarizationHook = (event: SummarizationEvent) => void;

// ════════════════════════════════════════════════════════════════════════════════
// Token 计数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Token 计数器接口。
 * 默认实现用粗略估算，可传入精确的 tokenizer。
 */
export interface TokenCounter {
    (text: string): number;
}

/**
 * 默认 Token 计数器（粗略估算）。
 * 英文 ~4 字符/token，中文 ~2 字符/token。
 */
export function defaultTokenCounter(text: string): number {
    let tokens = 0;
    for (const ch of text) {
        tokens += ch.charCodeAt(0) > 127 ? 2 : 0.25;
    }
    return Math.ceil(tokens);
}

// ════════════════════════════════════════════════════════════════════════════════
// 消息格式化
// ════════════════════════════════════════════════════════════════════════════════

function _htmlEscape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _boundText(text: string, cap: number): string {
    if (text.length <= cap) return text;
    if (cap <= 0) return "";
    const head = Math.floor(cap * 2 / 3);
    const marker = "\n...\n";
    if (cap <= marker.length) return text.slice(0, cap);
    const tail = Math.max(0, cap - head - marker.length);
    if (tail === 0) return text.slice(0, cap);
    return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function _formatMessages(messages: Array<Record<string, unknown>>): string {
    return messages.map((m) => {
        const role = m.type ?? "unknown";
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        const name = m.name ? ` (${m.name})` : "";
        return `[${role}${name}]: ${content}`;
    }).join("\n");
}

function _isDynamicContextReminder(msg: Record<string, unknown>): boolean {
    if (msg.type !== "system" && msg.type !== "human") return false;
    const kwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
    return kwargs[_DYNAMIC_CONTEXT_REMINDER_KEY] === true;
}

// ════════════════════════════════════════════════════════════════════════════════
// Token 感知截断
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 按 Token 上限截断文本。
 * strategy="first" 保留开头，strategy="last" 保留结尾。
 */
function _trimTextByTokens(
    text: string,
    maxTokens: number,
    strategy: "first" | "last",
    tokenCounter: TokenCounter,
): string {
    if (!text.trim() || maxTokens <= 0) return "";
    if (tokenCounter(text) <= maxTokens) return text;

    // 简单实现：按字符比例估算
    const ratio = maxTokens / Math.max(1, tokenCounter(text));
    const charLimit = Math.floor(text.length * ratio);

    if (strategy === "first") {
        return text.slice(0, Math.max(1, charLimit));
    }
    return text.slice(Math.max(0, text.length - charLimit));
}

/**
 * 构建摘要输入文本（带 Token 裁剪）。
 */
function _buildSummaryInputText(
    formattedMessages: string,
    previousSummary?: string | null,
    trimTokens?: number | null,
    tokenCounter?: TokenCounter,
): string | null {
    const counter = tokenCounter ?? defaultTokenCounter;

    let trimmedNewMessages = formattedMessages;
    let trimmedPreviousSummary = previousSummary?.trim() ?? "";

    if (trimTokens !== null && trimTokens !== undefined && trimTokens > 0) {
        const maxTokens = Math.max(1, trimTokens);

        if (previousSummary) {
            const newMessageTokens = Math.max(1, Math.floor(maxTokens / 2));
            const previousSummaryTokens = Math.max(1, maxTokens - newMessageTokens);

            trimmedPreviousSummary = _trimTextByTokens(
                previousSummary.trim(),
                previousSummaryTokens,
                "last",
                counter,
            );

            trimmedNewMessages = _trimTextByTokens(
                formattedMessages,
                newMessageTokens,
                "first",
                counter,
            );
        } else {
            trimmedNewMessages = _trimTextByTokens(formattedMessages, maxTokens, "first", counter);
        }
    }

    const parts: string[] = [];

    if (trimmedPreviousSummary) {
        parts.push(
            "<existing_summary>",
            _htmlEscape(trimmedPreviousSummary),
            "</existing_summary>",
            "",
        );
    }

    if (trimmedNewMessages) {
        parts.push(
            "<new_messages>",
            _htmlEscape(trimmedNewMessages),
            "</new_messages>",
        );
    }

    if (parts.length === 0) return null;
    return parts.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════════
// 摘要 prompt 构建
// ════════════════════════════════════════════════════════════════════════════════

function _buildSummaryPrompt(
    messagesToSummarize: Array<Record<string, unknown>>,
    config: SummarizationConfig,
    previousSummary?: string | null,
    _tokenCounter?: TokenCounter,
): string | null {
    if (messagesToSummarize.length === 0) return null;

    const promptTemplate = config.summary_prompt ?? _DEFAULT_SUMMARY_PROMPT;
    const formatted = _formatMessages(messagesToSummarize);

    const builtInput = _buildSummaryInputText(
        formatted,
        previousSummary,
        config.trim_tokens_to_summarize ?? _DEFAULT_TRIM_TOKENS_TO_SUMMARIZE,
        _tokenCounter ?? defaultTokenCounter,
    );

    if (!builtInput) return null;
    return promptTemplate.replace("{messages}", builtInput).trim();
}

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 检查是否需要压缩。
 */
export function shouldSummarize(
    messages: Array<Record<string, unknown>>,
    config?: SummarizationConfig,
    tokenCounter?: TokenCounter,
): boolean {
    if (config?.enabled === false) return false;

    const msgCount = config?.trigger_message_count ?? _DEFAULT_TRIGGER_MESSAGE_COUNT;
    const tokenCount = config?.trigger_token_count ?? _DEFAULT_TRIGGER_TOKEN_COUNT;

    if (messages.length > msgCount) return true;

    const counter = tokenCounter ?? defaultTokenCounter;
    const totalTokens = messages.reduce((sum, m) => {
        const content = typeof m.content === "string" ? m.content : "";
        return sum + counter(content);
    }, 0);

    return totalTokens > tokenCount;
}

/**
 * 确定截断位置。
 */
export function partitionMessages(
    messages: Array<Record<string, unknown>>,
    keepFirstN?: number,
    keepLastN?: number,
): [Array<Record<string, unknown>>, Array<Record<string, unknown>>] {
    const firstN = keepFirstN ?? _DEFAULT_KEEP_FIRST_N;
    const lastN = keepLastN ?? _DEFAULT_KEEP_LAST_N;

    if (messages.length <= firstN + lastN) return [[], messages];

    const head = messages.slice(0, firstN);
    const tail = messages.slice(-lastN);
    const toSummarize = messages.slice(firstN, -lastN);

    return [toSummarize, [...head, ...tail]];
}

/**
 * 保留动态上下文提醒。
 */
export function preserveDynamicContextReminders(
    messagesToSummarize: Array<Record<string, unknown>>,
    preservedMessages: Array<Record<string, unknown>>,
): [Array<Record<string, unknown>>, Array<Record<string, unknown>>] {
    const reminders = messagesToSummarize.filter((m) => _isDynamicContextReminder(m));
    if (reminders.length === 0) return [messagesToSummarize, preservedMessages];

    const baseIds = new Set<string>();
    for (const msg of reminders) {
        const id = msg.id as string | undefined;
        if (id) baseIds.add(id.replace(/__(?:memory|user)$/, ""));
    }

    const rescued: Array<Record<string, unknown>> = [];
    const remaining: Array<Record<string, unknown>> = [];

    for (const msg of messagesToSummarize) {
        const id = (msg.id as string) ?? "";
        if (_isDynamicContextReminder(msg) || (id && [...baseIds].some((b) => id.startsWith(b + "__")))) {
            rescued.push(msg);
        } else {
            remaining.push(msg);
        }
    }

    return [remaining, [...rescued, ...preservedMessages]];
}

/**
 * 执行上下文压缩。
 *
 * @param messages 消息列表
 * @param summarizeFn 生成摘要的函数（调用 LLM）
 * @param config 配置
 * @param hooks 压缩前 hooks
 * @param tokenCounter Token 计数器
 * @returns ContextCompactionResult | null
 */
export async function compactContext(
    messages: Array<Record<string, unknown>>,
    summarizeFn: (prompt: string) => Promise<string | null>,
    config?: SummarizationConfig,
    hooks?: BeforeSummarizationHook[],
    tokenCounter?: TokenCounter,
): Promise<ContextCompactionResult | null> {
    const counter = tokenCounter ?? defaultTokenCounter;

    if (!shouldSummarize(messages, config, counter)) return null;

    let [toSummarize, preserved] = partitionMessages(
        messages,
        config?.keep_first_n,
        config?.keep_last_n,
    );

    if (toSummarize.length === 0) return null;
    [toSummarize, preserved] = preserveDynamicContextReminders(toSummarize, preserved);
    if (toSummarize.length === 0) return null;

    // 计算总 Token 数
    const totalTokens = toSummarize.reduce((sum, m) => {
        const content = typeof m.content === "string" ? m.content : "";
        return sum + counter(content);
    }, 0);

    // 构建 prompt
    const prompt = _buildSummaryPrompt(toSummarize, config ?? {}, null, counter);
    if (!prompt) return null;

    // 触发 hooks
    if (hooks && hooks.length > 0) {
        const event: SummarizationEvent = {
            messages_to_summarize: toSummarize,
            preserved_messages: preserved,
            thread_id: null,
            agent_name: null,
        };
        for (const hook of hooks) {
            try { hook(event); } catch { /* hook 失败不影响主流程 */ }
        }
    }

    // 调 LLM 生成摘要
    const summaryText = await summarizeFn(prompt);
    if (!summaryText) return null;

    return {
        summary_text: summaryText,
        messages_to_summarize: toSummarize,
        preserved_messages: preserved,
        total_tokens: totalTokens,
    };
}

/**
 * 构建摘要消息。
 */
export function buildSummaryMessage(summaryText: string): Record<string, unknown> {
    return {
        type: "human",
        content: _boundText(summaryText, _SUMMARY_CHAR_BUDGET),
        name: _SUMMARY_TRIGGER_MESSAGE_NAME,
    };
}

/**
 * 应用压缩到 state。
 *
 * @param messages 当前消息列表
 * @param summarizeFn 摘要函数
 * @param config 配置
 * @param hooks 压缩前 hooks
 * @param tokenCounter Token 计数器
 * @returns state 更新或 null
 */
export async function applySummarization(
    messages: Array<Record<string, unknown>>,
    summarizeFn: (prompt: string) => Promise<string | null>,
    config?: SummarizationConfig,
    hooks?: BeforeSummarizationHook[],
    tokenCounter?: TokenCounter,
): Promise<Record<string, unknown> | null> {
    const result = await compactContext(messages, summarizeFn, config, hooks, tokenCounter);
    if (!result) return null;

    return {
        messages: [
            { type: "remove", id: "__all__" },
            ...result.preserved_messages,
            buildSummaryMessage(result.summary_text),
        ],
        summary_text: result.summary_text,
    };
}
