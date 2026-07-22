/**
 * 远程工具结果净化中间件 — 对不可信的远程内容做标签转义。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/tool_result_sanitization_middleware.py
 *
 * 问题：
 *   web_search 和 web_fetch 返回的是互联网上的内容。
 *   攻击者可以在网页里嵌入 <system-reminder> 标签来冒充系统指令。
 *   用户输入已经被 input_sanitization 净化了，但网页内容没有。
 *
 * 解决：
 *   对远程网络工具（web_search、web_fetch 等）的结果应用同样的 neutralizeUntrustedTags，
 *   把 <system> 转义成 &lt;system&gt;。
 *   本地工具（bash、read_file 等）的结果不动（代码和日志里有标签是正常的）。
 */

import { neutralizeUntrustedTags } from "./input_sanitization.js";

/**
 * 远程内容工具名白名单。
 *
 * 这些工具的返回结果来自互联网，攻击者可能控制其内容。
 * 本地工具（bash、read_file 等）不在此列表，其输出不会被转义。
 */
const _REMOTE_CONTENT_TOOL_NAMES = new Set([
    "web_fetch",
    "web_search",
    "image_search",
    "web_capture",
]);

// ════════════════════════════════════════════════════════════════════════════════
// 内容净化
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 对内容做标签转义，保持原始数据结构。
 *
 * 支持两种格式：
 *   1. 纯字符串 → 直接转义
 *   2. Content blocks 数组 → 只转义 type="text" 的 block，非文本不动
 *
 * @param content 消息内容
 * @returns 转义后的内容（如果不需要处理则返回原值）
 */
function _neutralizeContent(content: unknown): unknown {
    if (typeof content === "string") {
        return neutralizeUntrustedTags(content);
    }

    if (Array.isArray(content)) {
        const rebuilt: unknown[] = [];
        let changed = false;
        for (const block of content) {
            if (typeof block === "string") {
                const neutralized = neutralizeUntrustedTags(block);
                rebuilt.push(neutralized);
                if (neutralized !== block) changed = true;
            } else if (
                block &&
                typeof block === "object" &&
                (block as Record<string, unknown>).type === "text" &&
                typeof (block as Record<string, unknown>).text === "string"
            ) {
                const text = (block as Record<string, unknown>).text as string;
                const neutralized = neutralizeUntrustedTags(text);
                rebuilt.push({ ...(block as Record<string, unknown>), text: neutralized });
                if (neutralized !== text) changed = true;
            } else {
                rebuilt.push(block);
            }
        }
        return changed ? rebuilt : content;
    }

    return content;
}

/**
 * 对单条 ToolMessage 做内容净化。
 */
function _sanitizeToolMessage(msg: Record<string, unknown>): Record<string, unknown> {
    const newContent = _neutralizeContent(msg.content);
    if (newContent === msg.content) return msg;
    return { ...msg, content: newContent };
}

/**
 * 对工具调用结果做净化（处理 ToolMessage 或消息列表）。
 */
function _sanitizeResult(result: Record<string, unknown>): Record<string, unknown> {
    // 单个 ToolMessage
    if (result.type === "tool") {
        return _sanitizeToolMessage(result);
    }

    // 可能是包含 messages 列表的 Command-like 对象
    const update = result.update as Record<string, unknown> | undefined;
    if (update) {
        const messages = update.messages as Array<Record<string, unknown>> | undefined;
        if (messages && messages.length > 0) {
            let changed = false;
            const newMessages = messages.map((m) => {
                if (m.type === "tool") {
                    const sanitized = _sanitizeToolMessage(m);
                    if (sanitized !== m) changed = true;
                    return sanitized;
                }
                return m;
            });
            if (changed) {
                return { ...result, update: { ...update, messages: newMessages } };
            }
        }
    }

    return result;
}

// ════════════════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 判断一个工具是否是远程内容工具（需要净化结果）。
 */
export function isRemoteContentTool(toolName: string): boolean {
    return _REMOTE_CONTENT_TOOL_NAMES.has(toolName);
}

/**
 * 对远程网络工具的执行结果做标签转义。
 *
 * 在工具执行完成后调用。
 * 只处理 web_search / web_fetch / image_search / web_capture 的结果。
 *
 * @param toolName 工具名
 * @param result 工具执行结果消息
 * @returns 净化后的消息
 */
export function sanitizeToolResult(
    toolName: string,
    result: Record<string, unknown>,
): Record<string, unknown> {
    if (!_REMOTE_CONTENT_TOOL_NAMES.has(toolName)) return result;
    return _sanitizeResult(result);
}
