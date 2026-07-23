/**
 * 待办事项中间件 — 上下文丢失检测和过早退出阻止。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/todo_middleware.py
 *
 * 功能 1：当 summarization 压缩掉 write_todos 调用后，AI 不知道还有待办事项。
 *         检测到这种情况，注入提醒消息。
 *
 * 功能 2：AI 想退出但还有未完成的待办事项，阻止退出并注入提醒。
 *         最多提醒 2 次，防止死循环。
 */

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _MAX_COMPLETION_REMINDERS = 2;
const _MAX_COMPLETION_REMINDER_KEYS = 4096;

/** 写待办的工具名 */
const _WRITE_TODOS_TOOL_NAME = "write_todos";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface Todo {
    id?: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "failed";
    [key: string]: unknown;
}

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _todosInMessages(messages: Array<Record<string, unknown>>): boolean {
    for (const msg of messages) {
        if (msg.type !== "ai") continue;
        const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
        if (!toolCalls) continue;
        for (const tc of toolCalls) {
            if (tc.name === _WRITE_TODOS_TOOL_NAME) return true;
        }
    }
    return false;
}

function _reminderInMessages(messages: Array<Record<string, unknown>>, name: string): boolean {
    for (const msg of messages) {
        if (msg.type === "human" && msg.name === name) return true;
    }
    return false;
}

function _formatTodos(todos: Todo[]): string {
    return todos.map((t) => `- [${t.status}] ${t.content}`).join("\n");
}

function _formatCompletionReminder(todos: Todo[]): string {
    const incomplete = todos.filter((t) => t.status !== "completed");
    const text = incomplete.map((t) => `- [${t.status}] ${t.content}`).join("\n");
    return [
        "<system_reminder>",
        "You have incomplete todo items that must be finished before giving your final response:",
        "",
        text,
        "",
        'Please continue working on these tasks. Call `write_todos` to mark items as completed ',
        "as you finish them, and only respond when all items are done.",
        "</system_reminder>",
    ].join("\n");
}

function _hasToolCallIntent(msg: Record<string, unknown>): boolean {
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls && toolCalls.length > 0) return true;

    const additionalKwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
    if (additionalKwargs.tool_calls || additionalKwargs.function_call) return true;

    const responseMetadata = (msg.response_metadata as Record<string, unknown>) ?? {};
    const finishReason = responseMetadata.finish_reason as string | undefined;
    return finishReason === "tool_calls" || finishReason === "function_call";
}

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 待办事项跟踪器。
 */
export class TodoTracker {
    private _pendingReminders: Map<string, string[]> = new Map();
    private _reminderCounts: Map<string, number> = new Map();
    private _touchOrder: Map<string, number> = new Map();
    private _nextOrder = 0;

    private _key(threadId: string, runId: string): string {
        return `${threadId}:${runId}`;
    }

    private _prune(key: string): void {
        const keys = new Set([
            ...this._pendingReminders.keys(),
            ...this._reminderCounts.keys(),
            ...this._touchOrder.keys(),
        ]);
        const overflow = keys.size - _MAX_COMPLETION_REMINDER_KEYS;
        if (overflow <= 0) return;

        const candidates = [...keys].filter((k) => k !== key);
        candidates.sort((a, b) => (this._touchOrder.get(a) ?? 0) - (this._touchOrder.get(b) ?? 0));
        for (const k of candidates.slice(0, overflow)) {
            this._pendingReminders.delete(k);
            this._reminderCounts.delete(k);
            this._touchOrder.delete(k);
        }
    }

    // ── 上下文丢失检测 ───────────────────────────────────────────

    /**
     * 检测 write_todos 是否已被压缩出上下文，需要注入提醒。
     *
     * @param messages 当前消息列表
     * @param todos 当前待办列表
     * @returns 需要注入的提醒消息，或 null
     */
    detectContextLoss(
        messages: Array<Record<string, unknown>>,
        todos: Todo[],
    ): Record<string, unknown> | null {
        if (!todos || todos.length === 0) return null;
        if (_todosInMessages(messages)) return null; // 还在上下文中
        if (_reminderInMessages(messages, "todo_reminder")) return null; // 已注入过

        const formatted = _formatTodos(todos);
        return {
            type: "human",
            name: "todo_reminder",
            content: [
                "<system_reminder>",
                "Your todo list from earlier is no longer visible in the current context window, ",
                "but it is still active. Here is the current state:",
                "",
                formatted,
                "",
                "Continue tracking and updating this todo list as you work. ",
                "Call `write_todos` whenever the status of any item changes.",
                "</system_reminder>",
            ].join("\n"),
            additional_kwargs: { hide_from_ui: true },
        };
    }

    // ── 过早退出阻止 ─────────────────────────────────────────────

    /**
     * 检查 AI 是否想退出但还有未完成的待办。
     *
     * @param messages 消息列表
     * @param todos 待办列表
     * @param threadId 线程 ID
     * @param runId 运行 ID
     * @returns { reminder?, jumpToModel? }
     */
    checkPrematureExit(
        messages: Array<Record<string, unknown>>,
        todos: Todo[],
        threadId: string,
        runId: string,
    ): { reminder?: Record<string, unknown> | null; jumpToModel?: boolean } {
        const key = this._key(threadId, runId);

        // 没有待办或全部完成 → 允许退出
        if (!todos || todos.length === 0) return {};
        if (todos.every((t) => t.status === "completed")) return {};

        // 找最后一条 AI 消息
        let lastAi: Record<string, unknown> | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].type === "ai") {
                lastAi = messages[i];
                break;
            }
        }

        // AI 还在调工具 → 不干预
        if (lastAi && _hasToolCallIntent(lastAi)) return {};

        // 还没超过最大提醒次数
        const count = this._reminderCounts.get(key) ?? 0;
        if (count >= _MAX_COMPLETION_REMINDERS) return {};

        // 入队提醒
        const reminder = _formatCompletionReminder(todos);
        if (!this._pendingReminders.has(key)) this._pendingReminders.set(key, []);
        this._pendingReminders.get(key)!.push(reminder);
        this._reminderCounts.set(key, count + 1);
        this._touchOrder.set(key, ++this._nextOrder);
        this._prune(key);

        return { reminder: null, jumpToModel: true };
    }

    /**
     * 获取并清空待发送的完成提醒。
     */
    drainCompletionReminders(threadId: string, runId: string): string[] {
        const key = this._key(threadId, runId);
        const reminders = this._pendingReminders.get(key) ?? [];
        this._pendingReminders.delete(key);
        return reminders;
    }

    /**
     * 清除其他 run 的提醒。
     */
    clearOtherRunReminders(threadId: string, currentRunId: string): void {
        const keys = new Set([
            ...this._pendingReminders.keys(),
            ...this._reminderCounts.keys(),
            ...this._touchOrder.keys(),
        ]);
        for (const key of keys) {
            const [tid, rid] = key.split(":");
            if (tid === threadId && rid !== currentRunId) {
                this._pendingReminders.delete(key);
                this._reminderCounts.delete(key);
                this._touchOrder.delete(key);
            }
        }
    }

    /**
     * 清除当前 run 的提醒（Agent 结束后）。
     */
    clearCurrentRunReminders(threadId: string, runId: string): void {
        const key = this._key(threadId, runId);
        this._pendingReminders.delete(key);
        this._reminderCounts.delete(key);
        this._touchOrder.delete(key);
    }

    /**
     * 格式化待发送的完成提醒。
     */
    formatPendingReminders(reminders: string[]): string {
        return [...new Set(reminders)].join("\n\n");
    }
}
