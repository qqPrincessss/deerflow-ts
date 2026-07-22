/**
 * 消息处理工具 — 过滤和信号检测。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/memory/message_processing.py
 *
 * 作用：
 * 1. 过滤消息（去掉隐藏消息、上传文件标签）
 * 2. 检测用户纠正信号
 * 3. 检测用户正向强化信号
 */

import { readHumanInputResponse } from "../../agents/human_input.js";

// ════════════════════════════════════════════════════════════════
// 正则
// ════════════════════════════════════════════════════════════════

/** 上传文件块正则 */
const UPLOAD_BLOCK_RE = /<uploaded_files>[\s\S]*?<\/uploaded_files>\n*/gi;

/** 用户纠正信号模式 */
const CORRECTION_PATTERNS = [
    /that(?:'s| is) (?:wrong|incorrect)/i,
    /you misunderstood/i,
    /try again/i,
    /redo/i,
    /不对/,
    /你理解错了/,
    /你理解有误/,
    /重试/,
    /重新来/,
    /换一种/,
    /改用/,
];

/** 用户正向强化信号模式 */
const REINFORCEMENT_PATTERNS = [
    /yes[,.]?\s+(?:exactly|perfect|that(?:'s| is) (?:right|correct|it))/i,
    /perfect(?:[.!?]|$)/i,
    /exactly\s+(?:right|correct)/i,
    /that(?:'s| is)\s+(?:exactly\s+)?(?:right|correct|what i (?:wanted|needed|meant))/i,
    /keep\s+(?:doing\s+)?that/i,
    /just\s+(?:like\s+)?(?:that|this)/i,
    /this is (?:great|helpful)(?:[.!?]|$)/i,
    /this is what i wanted(?:[.!?]|$)/i,
    /对[，,]?\s*就是这样(?:[。！？!?.]|$)/,
    /完全正确(?:[。！？!?.]|$)/,
    /(?:对[，,]?\s*)?就是这个意思(?:[。！？!?.]|$)/,
    /正是我想要的(?:[。！？!?.]|$)/,
    /继续保持(?:[。！？!?.]|$)/,
];

// ════════════════════════════════════════════════════════════════
// 消息提取
// ════════════════════════════════════════════════════════════════

/**
 * 从消息中提取纯文本。
 */
function extractMessageText(message: { content: unknown }): string {
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
            if (typeof part === "string") parts.push(part);
            else if (part && typeof part === "object") {
                const textVal = (part as Record<string, unknown>).text;
                if (typeof textVal === "string") parts.push(textVal);
            }
        }
        return parts.join(" ");
    }
    return String(content ?? "");
}

// ════════════════════════════════════════════════════════════════
// 消息过滤
// ════════════════════════════════════════════════════════════════

/**
 * 过滤消息，只保留对记忆更新有用的消息。
 *
 * 规则：
 * 1. 去掉 hide_from_ui 的隐藏消息
 * 2. 去掉只有上传文件标签的 human 消息
 * 3. 如果 human 消息只有上传文件，跳过对应的 AI 回复
 */
export function filterMessagesForMemory(
    messages: Array<{ type?: string; content: unknown; additional_kwargs?: Record<string, unknown> }>
): Array<{ type?: string; content: unknown; additional_kwargs?: Record<string, unknown> }> {
    const filtered: Array<{ type?: string; content: unknown; additional_kwargs?: Record<string, unknown> }> = [];
    let skipNextAi = false;

    for (const msg of messages) {
        const msgType = msg.type;

        if (msgType === "human") {
            // 跳过 hide_from_ui 消息（非 human_input 响应）
            const kwargs = msg.additional_kwargs;
            if (kwargs?.hide_from_ui && !readHumanInputResponse(kwargs)) {
                continue;
            }

            const contentStr = extractMessageText(msg);
            if (contentStr.includes("<uploaded_files>")) {
                const stripped = contentStr.replace(UPLOAD_BLOCK_RE, "").trim();
                if (!stripped) {
                    skipNextAi = true;
                    continue;
                }
                filtered.push({ ...msg, content: stripped });
                skipNextAi = false;
            } else {
                filtered.push(msg);
                skipNextAi = false;
            }
        } else if (msgType === "ai") {
            const toolCalls = (msg as Record<string, unknown>).tool_calls;
            if (!toolCalls || (Array.isArray(toolCalls) && toolCalls.length === 0)) {
                if (skipNextAi) {
                    skipNextAi = false;
                    continue;
                }
                filtered.push(msg);
            }
        }
    }

    return filtered;
}

// ════════════════════════════════════════════════════════════════
// 信号检测
// ════════════════════════════════════════════════════════════════

/**
 * 检测用户的纠正信号。
 *
 * 扫描最近 6 条 human 消息，检查是否有纠正模式。
 */
export function detectCorrection(messages: Array<{ type?: string; content: unknown }>): boolean {
    const recentUserMsgs = messages
        .filter((msg) => msg.type === "human")
        .slice(-6);

    for (const msg of recentUserMsgs) {
        const content = extractMessageText(msg).trim();
        if (!content) continue;
        if (CORRECTION_PATTERNS.some((pattern) => pattern.test(content))) {
            return true;
        }
    }

    return false;
}

/**
 * 检测用户的正向强化信号。
 *
 * 扫描最近 6 条 human 消息，检查是否有正向强化模式。
 */
export function detectReinforcement(messages: Array<{ type?: string; content: unknown }>): boolean {
    const recentUserMsgs = messages
        .filter((msg) => msg.type === "human")
        .slice(-6);

    for (const msg of recentUserMsgs) {
        const content = extractMessageText(msg).trim();
        if (!content) continue;
        if (REINFORCEMENT_PATTERNS.some((pattern) => pattern.test(content))) {
            return true;
        }
    }

    return false;
}
