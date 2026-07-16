/**
 * DynamicContextMiddleware — 注入当前日期到消息里。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py
 *
 * 为什么需要？
 * LLM 不知道今天几号。你问"今天有什么安排"，它不知道。
 * 这个中间件在每次调用 LLM 前，把今天的日期注入到消息里。
 *
 * 为什么注入到用户消息，不放系统提示？
 * 系统提示是静态的，可以被 LLM 提供商缓存（省钱）。
 * 日期每天变，放系统提示里缓存就失效了。
 */

/**
 * 获取今天的日期，格式：2026-07-16
 */
export function getCurrentDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/**
 * 生成日期提醒文本。
 * 用 <system-reminder> 标签包裹，LLM 会把它当作系统信息。
 */
export function buildDateReminder(): string {
    const date = getCurrentDate();
    return `<system-reminder>Current date: ${date}</system-reminder>`;
}

/**
 * 检查消息列表里有没有已经注入过日期。
 *
 * 遍历所有消息，找有没有包含 <current_date> 标签的。
 * 有 → 说明已经注入过了，不需要再注入。
 */
export function hasInjectedDate(messages: string[]): boolean {
    return messages.some((msg) => msg.includes("<current_date>"));
}

/**
 * 给消息列表注入日期。
 *
 * 1. 检查有没有已经注入过
 * 2. 没有 → 在第一条用户消息前面加上日期
 * 3. 返回修改后的消息列表
 *
 * @param messages 消息内容列表（按顺序）
 * @returns 注入日期后的消息列表
 */
export function injectDate(messages: string[]): string[] {
    // 已经注入过了，不重复注入
    if (hasInjectedDate(messages)) {
        return messages;
    }

    const reminder = buildDateReminder();

    // 找到第一条用户消息，在它前面加上日期
    return messages.map((msg, index) => {
        // 只注入到第一条消息
        if (index === 0) {
            return `${reminder}\n${msg}`;
        }
        return msg;
    });
}
