/**
 * 标题生成中间件 — 第一次对话后自动生成对话标题。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/title_middleware.py
 *
 * 流程：
 *   1. 检查是否需要生成标题（配置启用、无现有标题、第一次对话）
 *   2. 提取第一条用户消息和第一条 AI 回复
 *   3. 用 LLM 生成标题
 *   4. LLM 失败时回退：截取用户消息前 N 字作为标题
 */

import { getAppConfig } from "../../config/app_config.js";
import { type TitleConfig } from "../../config/title_config.js";

// ════════════════════════════════════════════════════════════════════════════════
// 消息辅助
// ════════════════════════════════════════════════════════════════════════════════

/** 动态上下文提醒 key */
const _DYNAMIC_CONTEXT_REMINDER_KEY = "dynamic_context_reminder";

function _isDynamicContextReminder(msg: Record<string, unknown>): boolean {
    if (msg.type !== "system" && msg.type !== "human") return false;
    const kwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
    return kwargs[_DYNAMIC_CONTEXT_REMINDER_KEY] === true;
}

function _normalizeContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((item) => _normalizeContent(item)).filter(Boolean).join("\n");
    }
    if (typeof content === "object" && content !== null) {
        const obj = content as Record<string, unknown>;
        if (typeof obj.text === "string") return obj.text;
        if (obj.content !== undefined) return _normalizeContent(obj.content);
    }
    return "";
}

function _stripThinkTags(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 检查是否需要生成标题。
 */
export function shouldGenerateTitle(
    messages: Array<Record<string, unknown>>,
    currentTitle?: string | null,
    config?: Partial<TitleConfig>,
): boolean {
    if (config?.enabled === false) return false;
    if (config?.enabled === undefined) return true;
    if (currentTitle) return false;
    if (!messages || messages.length < 2) return false;

    const userMessages = messages.filter(
        (m) => m.type === "human" && !_isDynamicContextReminder(m),
    );
    const aiMessages = messages.filter((m) => m.type === "ai");

    return userMessages.length === 1 && aiMessages.length >= 1;
}

/**
 * 提取第一条用户消息作为回退标题。
 */
export function fallbackTitle(userMsg: string, config?: Partial<TitleConfig>): string {
    const maxChars = config?.max_chars ?? 50;
    const fallbackChars = Math.min(maxChars, 50);

    if (userMsg.length > fallbackChars) {
        const ellipsis = "...";
        const body = Math.min(fallbackChars, maxChars - ellipsis.length);
        return userMsg.slice(0, body).trimEnd() + ellipsis;
    }
    return userMsg || "New Conversation";
}

/**
 * 提取第一条用户消息。
 */
export function getFirstUserMessage(messages: Array<Record<string, unknown>>): string {
    for (const msg of messages) {
        if (msg.type === "human" && !_isDynamicContextReminder(msg)) {
            return _normalizeContent(msg.content);
        }
    }
    return "";
}

/**
 * 提取第一条 AI 回复。
 */
export function getFirstAiResponse(messages: Array<Record<string, unknown>>): string {
    for (const msg of messages) {
        if (msg.type === "ai") {
            const content = _normalizeContent(msg.content);
            return _stripThinkTags(content);
        }
    }
    return "";
}

/**
 * 构建标题生成 prompt。
 */
export function buildTitlePrompt(
    userMsg: string,
    aiResponse: string,
    config?: Partial<TitleConfig>,
): string {
    const maxWords = config?.max_words ?? 8;
    const template = config?.prompt_template ?? _DEFAULT_TITLE_PROMPT;
    return template
        .replace("{max_words}", String(maxWords))
        .replace("{user_msg}", userMsg.slice(0, 500))
        .replace("{assistant_msg}", aiResponse.slice(0, 500));
}

const _DEFAULT_TITLE_PROMPT = `Generate a concise title for this conversation in no more than {max_words} words.
Use the same language as the conversation. Return ONLY the title, no quotes, no punctuation.

User: {user_msg}
Assistant: {assistant_msg}
Title:`;

/**
 * 解析 LLM 返回的标题文本。
 */
export function parseTitle(content: unknown, config?: Partial<TitleConfig>): string {
    const maxChars = config?.max_chars ?? 100;
    let title = _normalizeContent(content);
    title = _stripThinkTags(title);
    title = title.trim().replace(/^["']|["']$/g, "");
    return title.length > maxChars ? title.slice(0, maxChars) : title;
}

/**
 * 生成标题（同步回退模式，不调 LLM）。
 *
 * @param messages 消息列表
 * @param config 标题配置
 * @returns { title } 或 null（不需要生成时）
 */
export function generateTitle(
    messages: Array<Record<string, unknown>>,
    config?: Partial<TitleConfig>,
): Record<string, unknown> | null {
    const resolvedConfig = config ?? _resolveTitleConfig();

    if (!shouldGenerateTitle(messages, undefined, resolvedConfig)) return null;

    const userMsg = getFirstUserMessage(messages);
    return { title: fallbackTitle(userMsg, resolvedConfig) };
}

/**
 * 生成标题（异步模式，调 LLM）。
 *
 * @param messages 消息列表
 * @param llmGenerate 调 LLM 生成文本的函数
 * @param config 标题配置
 * @returns { title } 或 null
 */
export async function generateTitleAsync(
    messages: Array<Record<string, unknown>>,
    llmGenerate?: ((prompt: string) => Promise<string | null>) | null,
    config?: Partial<TitleConfig>,
): Promise<Record<string, unknown> | null> {
    const resolvedConfig = config ?? _resolveTitleConfig();

    if (!shouldGenerateTitle(messages, undefined, resolvedConfig)) return null;

    const userMsg = getFirstUserMessage(messages);

    // 没有配置 LLM 模型 → 回退
    if (!resolvedConfig.model_name || !llmGenerate) {
        return { title: fallbackTitle(userMsg, resolvedConfig) };
    }

    const aiResponse = getFirstAiResponse(messages);
    const prompt = buildTitlePrompt(userMsg, aiResponse, resolvedConfig);

    try {
        const response = await llmGenerate(prompt);
        if (response) {
            const title = parseTitle(response, resolvedConfig);
            if (title) return { title };
        }
    } catch {
        // LLM 失败，回退
    }

    return { title: fallbackTitle(userMsg, resolvedConfig) };
}

function _resolveTitleConfig(): Partial<TitleConfig> {
    try {
        const appConfig = getAppConfig() as Record<string, unknown>;
        const title = appConfig.title;
        return title ? (title as Partial<TitleConfig>) : {};
    } catch {
        return {} as Partial<TitleConfig>;
    }
}
