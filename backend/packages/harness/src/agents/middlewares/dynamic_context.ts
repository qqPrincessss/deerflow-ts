/**
 * 动态上下文中间件 — 注入记忆和当前日期作为 system-reminder。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py
 *
 * 设计原则：
 *   System prompt 保持完全静态，最大化前缀缓存命中率。
 *   日期始终注入。用户记忆在 memory.injection_enabled 为 true 时注入。
 *
 * 第一次对话：注入完整 <system-reminder>（记忆 + 日期）
 * 跨天对话：注入轻量日期更新提醒
 */

import { type AppConfig } from "../../config/app_config.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _DYNAMIC_CONTEXT_REMINDER_KEY = "dynamic_context_reminder";
const _REMINDER_DATE_KEY = "reminder_date";
const _SUMMARY_MESSAGE_NAME = "summary";

// ════════════════════════════════════════════════════════════════════════════════
// 日期辅助
// ════════════════════════════════════════════════════════════════════════════════

function _today(): string {
    const d = new Date();
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}, ${weekdays[d.getDay()]}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// 消息检测
// ════════════════════════════════════════════════════════════════════════════════

function _isDynamicContextReminder(msg: Record<string, unknown>): boolean {
    if (msg.type !== "system" && msg.type !== "human") return false;
    const kwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
    return kwargs[_DYNAMIC_CONTEXT_REMINDER_KEY] === true;
}

function _lastInjectedDate(messages: Array<Record<string, unknown>>): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!_isDynamicContextReminder(msg)) continue;
        const kwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
        const date = kwargs[_REMINDER_DATE_KEY];
        if (typeof date === "string" && date) return date;

        // 向后兼容：从 SystemMessage 内容中解析 <current_date>
        if (msg.type === "system" && typeof msg.content === "string") {
            const m = msg.content.match(/<current_date>([^<]+)<\/current_date>/);
            if (m) return m[1];
        }
    }
    return null;
}

function _isUserInjectionTarget(msg: Record<string, unknown>): boolean {
    if (msg.type !== "human") return false;
    if (_isDynamicContextReminder(msg)) return false;
    if (msg.name === _SUMMARY_MESSAGE_NAME) return false;
    const id = msg.id as string | undefined;
    if (typeof id === "string" && id.endsWith("__user")) return false;
    return true;
}

// ════════════════════════════════════════════════════════════════════════════════
// 记忆上下文（占位，连接 Layer 10 后补全）
// ════════════════════════════════════════════════════════════════════════════════

function _getMemoryContext(_agentName?: string | null, _appConfig?: AppConfig | null): string {
    // TODO: 连接 agents/lead_agent/prompt.ts 的 _get_memory_context
    // 从记忆存储中读取用户记忆，格式化为 <memory>...</memory>
    return "";
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建提醒
// ════════════════════════════════════════════════════════════════════════════════

function _buildFullReminder(agentName?: string | null, appConfig?: AppConfig | null): [string, string | null] {
    let injectionEnabled = true;
    if (appConfig) {
        const cfg = appConfig as Record<string, unknown>;
        const memoryCfg = cfg.memory as Record<string, unknown> | undefined;
        if (memoryCfg && typeof memoryCfg.injection_enabled === "boolean") {
            injectionEnabled = memoryCfg.injection_enabled;
        }
    }

    const memoryContext = injectionEnabled ? _getMemoryContext(agentName, appConfig) : "";
    const currentDate = _today();

    const dateReminder = [
        "<system-reminder>",
        `<current_date>${currentDate}</current_date>`,
        "</system-reminder>",
    ].join("\n");

    const memoryBlock = memoryContext.trim() || null;
    return [dateReminder, memoryBlock];
}

function _buildDateUpdateReminder(): string {
    const currentDate = _today();
    return [
        "<system-reminder>",
        `<current_date>${currentDate}</current_date>`,
        "</system-reminder>",
    ].join("\n");
}

// ════════════════════════════════════════════════════════════════════════════════
// ID 交换消息构建
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 使用 ID 交换技术构建消息列表。
 *
 * SystemMessage 携带框架数据（日期）— 使用原消息 ID，add_messages 会原地替换。
 * HumanMessage 携带用户记忆（可选）— 使用 {id}__memory。
 * 真实用户消息 — 使用 {id}__user。
 */
function _makeReminderAndUserMessages(
    original: Record<string, unknown>,
    reminderContent: string,
    memoryContent?: string | null,
    reminderDate?: string | null,
): Array<Record<string, unknown>> {
    const stableId = (original.id as string) ?? `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const messages: Array<Record<string, unknown>> = [];

    const reminderKwargs: Record<string, unknown> = {
        hide_from_ui: true,
        [_DYNAMIC_CONTEXT_REMINDER_KEY]: true,
    };
    if (reminderDate) {
        reminderKwargs[_REMINDER_DATE_KEY] = reminderDate;
    }

    messages.push({
        type: "system",
        content: reminderContent,
        id: stableId,
        additional_kwargs: reminderKwargs,
    });

    if (memoryContent) {
        messages.push({
            type: "human",
            content: memoryContent,
            id: `${stableId}__memory`,
            additional_kwargs: {
                hide_from_ui: true,
                [_DYNAMIC_CONTEXT_REMINDER_KEY]: true,
            },
        });
    }

    messages.push({
        type: "human",
        content: original.content,
        id: `${stableId}__user`,
        name: original.name,
        additional_kwargs: original.additional_kwargs as Record<string, unknown> | undefined,
    });

    return messages;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 动态上下文中间件入口。
 *
 * 在 Agent 运行前调用。
 * 第一次对话：注入完整 system-reminder（记忆 + 日期）
 * 跨天：注入日期更新提醒
 * 同一天：什么都不做
 *
 * @param messages 当前消息列表
 * @param agentName Agent 名称（用于读取记忆）
 * @param appConfig 可选 AppConfig
 * @returns state 更新或 null
 */
export function injectDynamicContext(
    messages: Array<Record<string, unknown>>,
    agentName?: string | null,
    appConfig?: AppConfig | null,
): Record<string, unknown> | null {
    if (!messages || messages.length === 0) return null;

    const currentDate = _today();
    const lastDate = _lastInjectedDate(messages);

    if (lastDate === null) {
        // ── 第一次对话：注入完整提醒 ──
        const firstIdx = messages.findIndex((m) => _isUserInjectionTarget(m));
        if (firstIdx === -1) return null;

        const [dateReminder, memoryBlock] = _buildFullReminder(agentName, appConfig);
        const resultMsgs = _makeReminderAndUserMessages(
            messages[firstIdx],
            dateReminder,
            memoryBlock,
            currentDate,
        );

        return { messages: resultMsgs };
    }

    if (lastDate === currentDate) {
        // ── 同一天：不处理 ──
        return null;
    }

    // ── 跨天：注入日期更新 ──
    const lastHumanIdx = messages.length - 1 - [...messages].reverse().findIndex((m) => _isUserInjectionTarget(m));
    if (lastHumanIdx === -1 || lastHumanIdx >= messages.length) return null;

    const resultMsgs = _makeReminderAndUserMessages(
        messages[lastHumanIdx],
        _buildDateUpdateReminder(),
        null,
        currentDate,
    );

    return { messages: resultMsgs };
}
