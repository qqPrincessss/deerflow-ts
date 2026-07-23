/**
 * 图片注入中间件 — 在模型调用前将查看过的图片注入到对话中。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/view_image_middleware.py
 *
 * 流程：
 *   1. 模型调用前，检查最后一条 AI 消息是否有 view_image 工具调用
 *   2. 检查所有 view_image 调用是否都已完成（有对应的 ToolMessage）
 *   3. 如果满足条件，读取图片文件编码为 base64，注入为 HumanMessage
 *   4. 轻量元数据（path, mime_type, size）存在 state.viewed_images
 *     base64 数据不存 state，按需读取（避免 checkpoint 中存储大量二进制数据）
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const _VIEW_IMAGE_TOOL_NAME = "view_image";

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从消息列表中获取最后一条 AI 消息。
 */
function _getLastAssistantMessage(messages: Array<Record<string, unknown>>): Record<string, unknown> | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].type === "ai") return messages[i];
    }
    return null;
}

/**
 * 检查 AI 消息是否包含 view_image 工具调用。
 */
function _hasViewImageTool(message: Record<string, unknown>): boolean {
    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!toolCalls || toolCalls.length === 0) return false;
    return toolCalls.some((tc) => tc.name === _VIEW_IMAGE_TOOL_NAME);
}

/**
 * 检查 AI 消息中的所有工具调用是否都已执行完成。
 */
function _allToolsCompleted(messages: Array<Record<string, unknown>>, assistantMsg: Record<string, unknown>): boolean {
    const toolCalls = assistantMsg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!toolCalls) return false;

    const toolCallIds = new Set<string>();
    for (const tc of toolCalls) {
        const id = tc.id as string | undefined;
        if (id) toolCallIds.add(id);
    }

    if (toolCallIds.size === 0) return false;

    // 找到该 AI 消息的位置
    const assistantIdx = messages.indexOf(assistantMsg);
    if (assistantIdx === -1) return false;

    // 收集 AI 消息之后的 ToolMessage 的 ID
    const completedIds = new Set<string>();
    for (let i = assistantIdx + 1; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.type === "tool" && msg.tool_call_id) {
            completedIds.add(msg.tool_call_id as string);
        }
    }

    return [...toolCallIds].every((id) => completedIds.has(id));
}

/**
 * 检查是否已经注入过图片消息（防止重复注入）。
 */
function _alreadyInjected(messages: Array<Record<string, unknown>>, assistantMsg: Record<string, unknown>): boolean {
    const idx = messages.indexOf(assistantMsg);
    if (idx === -1) return false;

    for (let i = idx + 1; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.type === "human") {
            const content = typeof msg.content === "string" ? msg.content : "";
            if (content.includes("Here are the images you've viewed")) return true;
        }
    }
    return false;
}

/**
 * 读取图片文件并编码为 base64 data URL。
 */
function _readImageAsDataURL(actualPath: string, mimeType: string, expectedSize: number): string | null {
    try {
        if (!existsSync(actualPath)) return null;
        const stat = statSync(actualPath);
        if (stat.size !== expectedSize) return null; // 文件被修改
        if (stat.size > _MAX_IMAGE_BYTES) return null;

        const imageBytes = readFileSync(actualPath);
        const base64Data = imageBytes.toString("base64");
        return `data:${mimeType};base64,${base64Data}`;
    } catch {
        return null;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 在模型调用前注入图片消息（同步）。
 *
 * @param state 当前 state（包含 messages 和 viewed_images）
 * @returns state 更新或 null
 */
export function injectViewImages(
    state: Record<string, unknown>,
): Record<string, unknown> | null {
    const messages = (state.messages as Array<Record<string, unknown>>) ?? [];
    if (messages.length === 0) return null;

    const lastAssistant = _getLastAssistantMessage(messages);
    if (!lastAssistant) return null;

    // 检查是否是 view_image 调用
    if (!_hasViewImageTool(lastAssistant)) return null;

    // 检查是否全部完成
    if (!_allToolsCompleted(messages, lastAssistant)) return null;

    // 检查是否已注入过
    if (_alreadyInjected(messages, lastAssistant)) return null;

    // 从 state 读取 viewed_images
    const viewedImages = state.viewed_images as Record<string, Record<string, unknown>> | undefined;
    if (!viewedImages || Object.keys(viewedImages).length === 0) {
        return {
            messages: [{
                type: "human",
                content: "No images have been viewed.",
                additional_kwargs: { hide_from_ui: true },
            }],
        };
    }

    // 构建 content blocks
    const contentBlocks: unknown[] = [
        { type: "text", text: "Here are the images you've viewed:" },
    ];

    for (const [imagePath, imageData] of Object.entries(viewedImages)) {
        const mimeType = (imageData.mime_type as string) ?? "unknown";
        const actualPath = (imageData.actual_path as string) ?? "";
        const expectedSize = (imageData.size as number) ?? 0;

        contentBlocks.push({
            type: "text",
            text: `\n- **${imagePath}** (${mimeType})`,
        });

        if (actualPath) {
            const dataUrl = _readImageAsDataURL(actualPath, mimeType, expectedSize);
            if (dataUrl) {
                contentBlocks.push({
                    type: "image_url",
                    image_url: { url: dataUrl },
                });
            } else {
                contentBlocks.push({
                    type: "text",
                    text: `  (file unavailable or changed on disk: ${actualPath})`,
                });
            }
        }
    }

    return {
        messages: [{
            type: "human",
            content: contentBlocks,
            additional_kwargs: { hide_from_ui: true },
        }],
    };
}

/**
 * 异步读取图片文件并编码为 base64 data URL（不阻塞事件循环）。
 */
async function _readImageAsDataURLAsync(actualPath: string, mimeType: string, expectedSize: number): Promise<string | null> {
    try {
        if (!existsSync(actualPath)) return null;
        const stat = statSync(actualPath);
        if (stat.size !== expectedSize) return null;
        if (stat.size > _MAX_IMAGE_BYTES) return null;

        const imageBytes = await readFileAsync(actualPath);
        const base64Data = imageBytes.toString("base64");
        return `data:${mimeType};base64,${base64Data}`;
    } catch {
        return null;
    }
}

/**
 * 在模型调用前注入图片消息（异步，不阻塞事件循环）。
 *
 * @param state 当前 state
 * @returns state 更新或 null
 */
export async function ainjectViewImages(
    state: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
    const messages = (state.messages as Array<Record<string, unknown>>) ?? [];
    if (messages.length === 0) return null;

    const lastAssistant = _getLastAssistantMessage(messages);
    if (!lastAssistant) return null;
    if (!_hasViewImageTool(lastAssistant)) return null;
    if (!_allToolsCompleted(messages, lastAssistant)) return null;
    if (_alreadyInjected(messages, lastAssistant)) return null;

    const viewedImages = state.viewed_images as Record<string, Record<string, unknown>> | undefined;
    if (!viewedImages || Object.keys(viewedImages).length === 0) {
        return {
            messages: [{
                type: "human",
                content: "No images have been viewed.",
                additional_kwargs: { hide_from_ui: true },
            }],
        };
    }

    const contentBlocks: unknown[] = [
        { type: "text", text: "Here are the images you've viewed:" },
    ];

    for (const [imagePath, imageData] of Object.entries(viewedImages)) {
        const mimeType = (imageData.mime_type as string) ?? "unknown";
        const actualPath = (imageData.actual_path as string) ?? "";
        const expectedSize = (imageData.size as number) ?? 0;

        contentBlocks.push({
            type: "text",
            text: `\n- **${imagePath}** (${mimeType})`,
        });

        if (actualPath) {
            const dataUrl = await _readImageAsDataURLAsync(actualPath, mimeType, expectedSize);
            if (dataUrl) {
                contentBlocks.push({
                    type: "image_url",
                    image_url: { url: dataUrl },
                });
            } else {
                contentBlocks.push({
                    type: "text",
                    text: `  (file unavailable or changed on disk: ${actualPath})`,
                });
            }
        }
    }

    return {
        messages: [{
            type: "human",
            content: contentBlocks,
            additional_kwargs: { hide_from_ui: true },
        }],
    };
}
