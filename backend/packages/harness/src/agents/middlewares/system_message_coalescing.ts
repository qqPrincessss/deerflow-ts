/**
 * 系统消息合并中间件 — 将多条 SystemMessage 合并为一条引导消息。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/system_message_coalescing_middleware.py
 *
 * 问题：vLLM、SGLang、Anthropic 等严格后端拒绝多条 SystemMessage。
 * DeerFlow 的 DynamicContextMiddleware 会在消息中插入 SystemMessage 日期提醒，
 * 导致出现多条 SystemMessage。这个中间件把它们合并成一条。
 *
 * 设计：
 * - wrap_model_call 中执行（不碰持久化的 state）
 * - 合并 system_message 字段 + messages 中的所有 SystemMessage
 * - 去重 dynamic_context_reminder，只保留最新的日期
 * - 保留第一条 SystemMessage 的 id（下游 key 不受影响）
 */

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

const _DYNAMIC_CONTEXT_REMINDER_KEY = "dynamic_context_reminder";

function _isDynamicContextReminder(msg: Record<string, unknown>): boolean {
    if (msg.type !== "system" && msg.type !== "human") return false;
    const kwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
    return kwargs[_DYNAMIC_CONTEXT_REMINDER_KEY] === true;
}

function _flattenContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") return item;
                if (typeof item === "object" && item !== null) {
                    const obj = item as Record<string, unknown>;
                    if (typeof obj.text === "string") return obj.text;
                }
                return String(item);
            })
            .join("\n");
    }
    return String(content ?? "");
}

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 合并系统消息。
 *
 * @param systemMessage 单独的 system_message 字段
 * @param messages 消息列表
 * @returns { systemMessage, messages } 合并后的结果，或 null（无需合并）
 */
export function coalesceSystemMessages(
    systemMessage: Record<string, unknown> | null | undefined,
    messages: Array<Record<string, unknown>>,
): { systemMessage: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null {
    // 找出 messages 中所有的 SystemMessage
    const inMsgSystems = messages.filter((m) => m.type === "system");
    if (inMsgSystems.length === 0) return null;

    // 收集所有要合并的 SystemMessage
    const parts: Array<Record<string, unknown>> = [];
    if (systemMessage) parts.push(systemMessage);
    parts.push(...inMsgSystems);

    // 去重 dynamic_context_reminder：只保留最后一条
    const reminderIndices: number[] = [];
    for (let i = 0; i < parts.length; i++) {
        if (_isDynamicContextReminder(parts[i])) {
            reminderIndices.push(i);
        }
    }
    if (reminderIndices.length > 1) {
        const keepLast = reminderIndices[reminderIndices.length - 1];
        const filtered: Array<Record<string, unknown>> = [];
        for (let i = 0; i < parts.length; i++) {
            if (reminderIndices.includes(i) && i !== keepLast) continue;
            filtered.push(parts[i]);
        }
        // 用过滤后的替换 parts
        parts.length = 0;
        parts.push(...filtered);
    }

    // 合并内容
    const mergedContent = parts.map((p) => _flattenContent(p.content)).join("\n\n");

    // 保留第一条的 id
    const first = parts[0];

    // 合并 additional_kwargs
    const mergedKwargs: Record<string, unknown> = {};
    for (const p of parts) {
        const kwargs = (p.additional_kwargs as Record<string, unknown>) ?? {};
        Object.assign(mergedKwargs, kwargs);
    }

    // 构建合并后的 system_message
    const mergedSystemMessage: Record<string, unknown> = {
        ...first,
        type: "system",
        content: mergedContent,
        additional_kwargs: mergedKwargs,
    };

    // 移除非 system 消息
    const nonSystem = messages.filter((m) => m.type !== "system");

    return {
        systemMessage: mergedSystemMessage,
        messages: nonSystem,
    };
}

/**
 * 合并系统消息 — 返回新对象，不修改入参。
 *
 * @param systemMessage 单独的 system_message 字段
 * @param messages 消息列表
 * @returns { systemMessage, messages } 新对象，或 null（无需合并）
 */
export function applySystemMessageCoalescing(
    systemMessage: Record<string, unknown> | null | undefined,
    messages: Array<Record<string, unknown>>,
): { systemMessage: Record<string, unknown>; messages: Array<Record<string, unknown>> } | null {
    const result = coalesceSystemMessages(systemMessage, messages);
    if (!result) return null;

    // 返回新对象，不修改入参
    return {
        systemMessage: { ...result.systemMessage },
        messages: [...result.messages],
    };
}
