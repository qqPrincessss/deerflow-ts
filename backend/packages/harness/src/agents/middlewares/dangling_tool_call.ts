/**
 * 悬空工具调用中间件 — 修复消息历史中缺失/多余的工具结果。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/dangling_tool_call_middleware.py
 *
 * 两种问题：
 *   1. 悬空工具调用（Dangling）：AI 说要调工具，但没有对应的工具结果
 *      → 因为用户中断或请求取消，ToolMessage 没生成
 *      → 严格 API 提供商会报错
 *      → 解决方案：插入虚假的 ToolMessage，带错误信息
 *
 *   2. 孤儿工具结果（Orphan）：有工具结果，但发起调用的 AI 消息被压缩/删除了
 *      → 因为 summarization 中间件压缩了对话
 *      → 严格 API 提供商会报 400
 *      → 解决方案：从请求中删除这些孤儿 ToolMessage
 *
 * 注意：修改仅影响当前模型请求，不修改持久化的 state。
 */

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _MAX_RECOVERY_ERROR_DETAIL_LEN = 500;
const _UNKNOWN_TOOL_NAME = "unknown_tool";
const _EMPTY_TOOL_NAME_ERROR = "Tool call could not be executed because its name was missing or empty.";

// ════════════════════════════════════════════════════════════════════════════════
// 工具名校验
// ════════════════════════════════════════════════════════════════════════════════

function _validToolName(name: unknown): name is string {
    return typeof name === "string" && name.trim().length > 0;
}

function _normalizeToolName(name: unknown): string {
    if (_validToolName(name)) return name.trim();
    return _UNKNOWN_TOOL_NAME;
}

function _hasInvalidToolName(name: unknown): boolean {
    return !_validToolName(name);
}

// ════════════════════════════════════════════════════════════════════════════════
// 从 AI 消息中提取工具调用
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从 AI 消息中提取规范化的工具调用列表。
 *
 * 处理三种数据源：
 *   1. msg.tool_calls — 标准结构化工具调用
 *   2. msg.additional_kwargs.tool_calls — 原始 provider 格式
 *   3. msg.invalid_tool_calls — 格式错误的工具调用（JSON 解析失败等）
 */
function _messageToolCalls(msg: Record<string, unknown>): Array<Record<string, unknown>> {
    const normalized: Array<Record<string, unknown>> = [];

    // 1. 标准 tool_calls
    const toolCalls = (msg.tool_calls as Array<Record<string, unknown>>) ?? [];
    for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall !== "object") continue;
        const originalName = toolCall.name;
        const normalizedCall: Record<string, unknown> = { ...toolCall };
        normalizedCall.name = _normalizeToolName(originalName);
        if (_hasInvalidToolName(originalName)) {
            normalizedCall.invalid_tool_name = true;
        }
        normalized.push(normalizedCall);
    }

    // 2. additional_kwargs.tool_calls（原始 provider 格式）
    const additionalKwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
    const rawToolCalls = (additionalKwargs.tool_calls as Array<Record<string, unknown>>) ?? [];
    if (toolCalls.length === 0 && rawToolCalls.length > 0) {
        for (const raw of rawToolCalls) {
            if (!raw || typeof raw !== "object") continue;

            const function_ = raw.function as Record<string, unknown> | undefined;
            let name = raw.name as string | undefined;
            if (!name && function_) {
                name = function_.name as string | undefined;
            }

            let args: Record<string, unknown> = {};
            const rawArgs = raw.args ?? function_?.arguments;
            if (typeof rawArgs === "string") {
                try {
                    const parsed = JSON.parse(rawArgs);
                    if (typeof parsed === "object" && parsed !== null) args = parsed;
                } catch { /* 解析失败，用空对象 */ }
            } else if (typeof rawArgs === "object" && rawArgs !== null) {
                args = rawArgs as Record<string, unknown>;
            }

            const normalizedCall: Record<string, unknown> = {
                id: raw.id,
                name: _normalizeToolName(name),
                args,
            };
            if (_hasInvalidToolName(name)) {
                normalizedCall.invalid_tool_name = true;
            }
            normalized.push(normalizedCall);
        }
    }

    return normalized;
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建合成错误消息
// ════════════════════════════════════════════════════════════════════════════════

function _syntheticToolMessageContent(toolCall: Record<string, unknown>): string {
    if (toolCall.invalid_tool_name) {
        return `[${_EMPTY_TOOL_NAME_ERROR} Use one of the available tool names when retrying.]`;
    }

    if (toolCall.invalid) {
        const name = toolCall.name as string;
        const error = toolCall.error as string | undefined;
        const errorText = error?.slice(0, _MAX_RECOVERY_ERROR_DETAIL_LEN) ?? "";

        if (name === "write_file") {
            const details = errorText ? ` Parser error: ${errorText}` : "";
            return (
                "[write_file failed before execution: the tool-call arguments were not valid JSON, " +
                "so no file was written. This often happens when the model tries to write a very " +
                "large Markdown file in a single tool call, especially when `content` contains " +
                "unescaped quotes, inline JSON, backslashes, or code fences. Do not retry the same " +
                "large `write_file` payload for this artifact; provide the report/content directly " +
                "as normal assistant text in your next response. If a file write is still needed " +
                `later, split the file into smaller sections instead of one large payload.${details}]`
            );
        }

        if (errorText) {
            return `[Tool call could not be executed because its arguments were invalid: ${errorText}]`;
        }
        return "[Tool call could not be executed because its arguments were invalid.]";
    }

    return "[Tool call was interrupted and did not return a result.]";
}

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 修复消息列表中的悬空工具调用和孤儿工具结果。
 *
 * 在模型调用前调用。
 *
 * 逻辑：
 *   1. 建立 tool_call_id → ToolMessage 的映射
 *   2. 收集所有 AI 消息中的工具调用 ID
 *   3. 遍历消息列表：
 *      - ToolMessage：如果 ID 在映射中，跳过（等会在 AI 消息后重新插入）
 *      - ToolMessage：如果 ID 不在映射中（孤儿），删除
 *      - AI 消息：保留，然后在后面插入对应的 ToolMessage（如果有）
 *      - AI 消息：如果缺少 ToolMessage（悬空），插入合成的错误 ToolMessage
 *
 * @param messages 消息列表
 * @returns 修复后的消息列表，或 null（无需修复）
 */
export function fixDanglingToolCalls(
    messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> | null {
    // 建立 tool_call_id → ToolMessage 的映射
    const toolMessagesById = new Map<string, Array<Record<string, unknown>>>();
    for (const msg of messages) {
        if (msg.type === "tool") {
            const id = msg.tool_call_id as string | undefined;
            if (id) {
                if (!toolMessagesById.has(id)) {
                    toolMessagesById.set(id, []);
                }
                toolMessagesById.get(id)!.push(msg);
            }
        }
    }

    // 收集所有 AI 消息中提到的工具调用 ID
    const toolCallIds = new Set<string>();
    for (const msg of messages) {
        if (msg.type !== "ai") continue;
        for (const tc of _messageToolCalls(msg)) {
            const tcId = tc.id as string | undefined;
            if (tcId) toolCallIds.add(tcId);
        }
    }

    // 遍历并修复
    const patched: Array<Record<string, unknown>> = [];
    let patchCount = 0;
    let dropCount = 0;

    for (const msg of messages) {
        if (msg.type === "tool") {
            const id = msg.tool_call_id as string | undefined;
            if (id && toolCallIds.has(id)) {
                // 这个 ToolMessage 属于一个已知的 AI 调用
                // 跳过，等会在对应的 AI 消息后面重新插入
                continue;
            }
            // 孤儿 ToolMessage：对应的 AI 消息已经不在了
            // 删除它
            dropCount++;
            continue;
        }

        patched.push(msg);

        if (msg.type !== "ai") continue;

        // 对当前 AI 消息中的每个工具调用，检查是否有对应的 ToolMessage
        for (const tc of _messageToolCalls(msg)) {
            const tcId = tc.id as string | undefined;
            if (!tcId) continue;

            // tool_call_id → ToolMessage 队列（如果有多个同 ID 的 ToolMessage）
            const queue = toolMessagesById.get(tcId);
            const existing = queue?.shift() ?? null;

            if (existing !== null) {
                // 已有对应的 ToolMessage，保留
                if (tc.invalid_tool_name && _hasInvalidToolName(existing.name)) {
                    existing.name = tc.name;
                }
                patched.push(existing);
            } else {
                // 没有对应的 ToolMessage（悬空）
                // 插入合成的错误消息
                const tcName = (tc.name as string) ?? "unknown";
                patched.push({
                    type: "tool",
                    content: _syntheticToolMessageContent(tc),
                    tool_call_id: tcId,
                    name: tcName,
                    status: "error",
                });
                patchCount++;
            }
        }
    }

    if (patched.length === messages.length && dropCount === 0) return null;

    if (dropCount > 0 || patchCount > 0) {
        console.warn(
            `DanglingToolCallMiddleware: ${dropCount} orphan(s) dropped, ${patchCount} placeholder(s) injected`,
        );
    }

    return patched;
}
