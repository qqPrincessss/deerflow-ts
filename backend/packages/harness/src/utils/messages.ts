import { type HumanMessage, type AIMessage, type ToolMessage } from "@langchain/core/messages"

/** 原始用户内容 key */
export const ORIGINAL_USER_CONTENT_KEY = "original_user_content";

/** 摘要消息名 */
export const SUMMARY_MESSAGE_NAME = "summary";

export function messageContentToText(content: unknown): string {
    if (typeof content === 'string') {
        return content ?? '';
    } else if (Array.isArray(content)) {
        let result = "";
        content.forEach((item) => {
            if (typeof item === "string") {
                result += item + "\n";
            } else if (typeof item === "object" && item !== null) {
                const text = (item as Record<string, unknown>).text;
                if (typeof text === "string") {
                    result += text + "\n"
                }
            }
        })
        return result;
    } else {
        return String(content);
    }

}
export function messageToText(message: AIMessage | HumanMessage): string {
    const content = message.content;
    if (typeof content === "string") {
        return content;
    } else if (Array.isArray(content)) {
        let result = '';
        content.forEach((item) => {
            if (typeof item === "string") {
                result += item + " "
            } else if (typeof item === "object" && item !== null) {
                const text = (item as Record<string, unknown>).text;
                if (typeof text === "string") {
                    result += text + "\n"
                }
            }
        })
        return result;
    } else if (typeof content === "object") {
        const obj = content as Record<string, unknown>;
        // 检查 text key
        if (typeof obj.text === "string") {
            return obj.text;
        }
        // 检查 content key
        if (typeof obj.content === "string") {
            return obj.content;
        }
    }
    return "";
}

/**
 * 获取原始用户文本（中间件处理前的）。
 *
 * 中间件可能会修改消息内容（注入日期、记忆等），
 * 但有时候需要拿到"原始的、没被修改过的"用户文本。
 */
export function getOriginalUserContentText(
    content: unknown,
    additionalKwargs: Record<string, unknown> | null | undefined
): string {
    const originalContent = additionalKwargs?.[ORIGINAL_USER_CONTENT_KEY];
    if (typeof originalContent === "string") {
        return originalContent;
    }
    return messageContentToText(content);
}

/**
 * 判断是否是真正的用户消息（排除中间件注入的隐藏消息）。
 *
 * 有些消息看起来像用户发的，但其实是中间件注入的（摘要、隐藏消息）。
 */
export function isRealUserMessage(message: unknown): boolean {
    const msg = message as Record<string, unknown>;
    if (!msg || msg.constructor?.name !== "HumanMessage") {
        return false;
    }
    if (msg.name === SUMMARY_MESSAGE_NAME) {
        return false;
    }
    const kwargs = msg.additional_kwargs as Record<string, unknown> | undefined;
    if (kwargs?.hide_from_ui) {
        return false;
    }
    return true;
}

/**
 * 构建 UI 显示用的用户消息副本（还原被中间件修改的消息）。
 *
 * 中间件会修改用户消息（注入日期、记忆），但 UI 要显示"原始的"消息。
 * 这个函数把修改后的消息还原成原始版本。
 *
 * 对应原项目：backend/packages/harness/deerflow/utils/messages.py 的 restore_original_human_message
 */
export function restoreOriginalHumanMessage(message: HumanMessage): HumanMessage {
    const kwargs = message.additional_kwargs as Record<string, unknown> | undefined;
    const originalContent = kwargs?.[ORIGINAL_USER_CONTENT_KEY];

    if (typeof originalContent !== "string") {
        return message;
    }

    // 移除 original_user_content key
    const newKwargs = { ...kwargs };
    delete newKwargs[ORIGINAL_USER_CONTENT_KEY];

    const content = message.content;
    let restoredContent: unknown;

    if (typeof content === "string") {
        // 内容是字符串，直接替换
        restoredContent = originalContent;
    } else if (Array.isArray(content)) {
        // 内容是数组，替换第一个文本块
        const restored: unknown[] = [];
        let restoredText = false;

        for (const block of content) {
            const isStringText = typeof block === "string";
            const isMappingText =
                typeof block === "object" &&
                block !== null &&
                (block as Record<string, unknown>).type === "text" &&
                typeof (block as Record<string, unknown>).text === "string";

            if (!isStringText && !isMappingText) {
                restored.push(block);
                continue;
            }

            if (restoredText) {
                continue; // 跳过后续文本块
            }

            if (isMappingText) {
                restored.push({ ...block, text: originalContent });
            } else {
                restored.push(originalContent);
            }
            restoredText = true;
        }

        if (!restoredText) {
            restored.unshift({ type: "text", text: originalContent });
        }

        restoredContent = restored;
    } else {
        restoredContent = originalContent;
    }

    // 返回新消息（不修改原消息）
    return {
        ...message,
        content: restoredContent as string | unknown[],
        additional_kwargs: newKwargs,
    } as HumanMessage;
}