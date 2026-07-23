/**
 * Token 用量中间件 — 记录 Token 用量并标注步骤归因。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/token_usage_middleware.py
 *
 * 功能：
 *   1. 记录每次 LLM 调用的 Token 用量（input/output/total）
 *   2. 给每条 AIMessage 打上"归因标签"，描述 AI 在这一步做了什么
 *   3. 合并子代理的 Token 用量到派发它的 AIMessage 上
 */

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

export const TOKEN_USAGE_ATTRIBUTION_KEY = "token_usage_attribution";

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _stringArg(value: unknown): string | null {
    if (typeof value === "string") {
        const normalized = value.trim();
        return normalized || null;
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// Todo 变更检测
// ════════════════════════════════════════════════════════════════════════════════

interface Todo {
    content?: string;
    status?: string;
    [key: string]: unknown;
}

function _normalizeTodos(value: unknown): Todo[] {
    if (!Array.isArray(value)) return [];

    const normalized: Todo[] = [];
    for (const item of value) {
        if (typeof item !== "object" || item === null) continue;
        const todo = item as Record<string, unknown>;
        const content = _stringArg(todo.content);
        const status = todo.status;
        if (content !== null) {
            normalized.push({
                content,
                status: typeof status === "string" && ["pending", "in_progress", "completed"].includes(status) ? status : undefined,
            });
        }
    }
    return normalized;
}

function _todoActionKind(previous: Todo | null, current: Todo): string {
    const status = current.status;
    if (!previous) {
        if (status === "completed") return "todo_complete";
        if (status === "in_progress") return "todo_start";
        return "todo_update";
    }
    if (previous.content !== current.content) return "todo_update";
    if (status === "completed") return "todo_complete";
    if (status === "in_progress") return "todo_start";
    return "todo_update";
}

function _buildTodoActions(previousTodos: Todo[], nextTodos: Todo[]): Record<string, unknown>[] {
    const previousByContent = new Map<string, Array<{ index: number; todo: Todo }>>();
    const matchedIndices = new Set<number>();

    for (let i = 0; i < previousTodos.length; i++) {
        const content = previousTodos[i].content;
        if (content) {
            if (!previousByContent.has(content)) previousByContent.set(content, []);
            previousByContent.get(content)!.push({ index: i, todo: previousTodos[i] });
        }
    }

    const actions: Record<string, unknown>[] = [];

    for (let i = 0; i < nextTodos.length; i++) {
        const content = nextTodos[i].content;
        if (!content) continue;

        let previousMatch: Todo | null = null;
        const matches = previousByContent.get(content);
        if (matches) {
            while (matches.length > 0 && matchedIndices.has(matches[0].index)) matches.shift();
            if (matches.length > 0) {
                const match = matches.shift()!;
                matchedIndices.add(match.index);
                previousMatch = match.todo;
            }
        }

        if (!previousMatch && !previousByContent.has(content) && i < previousTodos.length && !matchedIndices.has(i)) {
            previousMatch = previousTodos[i];
            matchedIndices.add(i);
        }

        if (previousMatch) {
            if (previousMatch.content === content && previousMatch.status === nextTodos[i].status) continue;
        }

        actions.push({
            kind: _todoActionKind(previousMatch, nextTodos[i]),
            content,
        });
    }

    for (let i = 0; i < previousTodos.length; i++) {
        if (matchedIndices.has(i)) continue;
        const content = previousTodos[i].content;
        if (!content) continue;
        actions.push({ kind: "todo_remove", content });
    }

    return actions;
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具调用描述
// ════════════════════════════════════════════════════════════════════════════════

function _describeToolCall(
    toolCall: Record<string, unknown>,
    todos: Todo[],
): Record<string, unknown>[] {
    const name = _stringArg(toolCall.name as string) ?? "unknown";
    const args = (typeof toolCall.args === "object" && toolCall.args !== null ? toolCall.args : {}) as Record<string, unknown>;
    const toolCallId = _stringArg(toolCall.id as string);

    if (name === "write_todos") {
        const nextTodos = _normalizeTodos(args.todos);
        const actions = _buildTodoActions(todos, nextTodos);
        if (actions.length === 0) {
            return [{ kind: "tool", tool_name: name, tool_call_id: toolCallId }];
        }
        return actions.map((a) => ({ ...a, tool_call_id: toolCallId }));
    }

    if (name === "task") {
        return [{
            kind: "subagent",
            description: _stringArg(args.description as string),
            subagent_type: _stringArg(args.subagent_type as string),
            tool_call_id: toolCallId,
        }];
    }

    if (name === "web_search" || name === "image_search") {
        return [{
            kind: "search",
            tool_name: name,
            query: _stringArg(args.query as string),
            tool_call_id: toolCallId,
        }];
    }

    if (name === "present_files") {
        return [{ kind: "present_files", tool_call_id: toolCallId }];
    }

    if (name === "ask_clarification") {
        return [{ kind: "clarification", tool_call_id: toolCallId }];
    }

    return [{
        kind: "tool",
        tool_name: name,
        description: _stringArg(args.description as string),
        tool_call_id: toolCallId,
    }];
}

function _inferStepKind(actions: Record<string, unknown>[], content: unknown): string {
    if (actions.length > 0) {
        const firstKind = actions[0].kind;
        if (actions.length === 1 && typeof firstKind === "string" && firstKind.startsWith("todo_")) {
            return "todo_update";
        }
        if (actions.length === 1 && firstKind === "subagent") {
            return "subagent_dispatch";
        }
        return "tool_batch";
    }
    if (content) return "final_answer";
    return "thinking";
}

// ════════════════════════════════════════════════════════════════════════════════
// 归因构建
// ════════════════════════════════════════════════════════════════════════════════

function _buildAttribution(
    message: Record<string, unknown>,
    todos: Todo[],
): Record<string, unknown> {
    const toolCalls = (message.tool_calls as Array<Record<string, unknown>>) ?? [];
    const actions: Record<string, unknown>[] = [];
    let currentTodos = [...todos];

    for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const described = _describeToolCall(tc, currentTodos);
        actions.push(...described);

        if (tc.name === "write_todos") {
            const args = (typeof tc.args === "object" && tc.args !== null ? tc.args : {}) as Record<string, unknown>;
            currentTodos = _normalizeTodos(args.todos);
        }
    }

    const toolCallIds: string[] = [];
    for (const tc of toolCalls) {
        if (typeof tc !== "object" || tc === null) continue;
        const id = _stringArg(tc.id as string);
        if (id) toolCallIds.push(id);
    }

    return {
        version: 1,
        kind: _inferStepKind(actions, message.content),
        shared_attribution: actions.length > 1,
        tool_call_ids: toolCallIds,
        actions,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 在模型调用后处理 Token 用量记录和步骤归因。
 *
 * @param messages 当前消息列表
 * @param todos 当前待办列表
 * @param cachedSubagentUsage 缓存的子代理 Token 用量（tool_call_id → usage）
 * @returns state 更新或 null
 */
export function annotateTokenUsage(
    messages: Array<Record<string, unknown>>,
    todos: Todo[],
    cachedSubagentUsage?: Map<string, Record<string, number>>,
): Record<string, unknown> | null {
    if (!messages || messages.length === 0) return null;

    // 子代理 Token 用量合并到派发它的 AIMessage
    const stateUpdates = new Map<number, Record<string, unknown>>();

    if (cachedSubagentUsage && messages.length >= 2) {
        for (let idx = messages.length - 2; idx >= 0; idx--) {
            const toolMsg = messages[idx];
            if (toolMsg.type !== "tool" || !toolMsg.tool_call_id) break;

            const subagentUsage = cachedSubagentUsage.get(toolMsg.tool_call_id as string);
            if (subagentUsage) {
                // 往前找派发它的 AIMessage
                for (let di = idx - 1; di >= 0; di--) {
                    const candidate = messages[di];
                    if (candidate.type !== "ai") continue;
                    const tcArray = candidate.tool_calls as Array<Record<string, unknown>> | undefined;
                    if (tcArray?.some((tc) => tc.id === toolMsg.tool_call_id)) {
                        const existing = stateUpdates.get(di);
                        const prevUsage = existing?.usage_metadata as Record<string, number> ?? (candidate.usage_metadata as Record<string, number>) ?? {};
                        const merged = {
                            ...prevUsage,
                            input_tokens: (prevUsage.input_tokens ?? 0) + (subagentUsage.input_tokens ?? 0),
                            output_tokens: (prevUsage.output_tokens ?? 0) + (subagentUsage.output_tokens ?? 0),
                            total_tokens: (prevUsage.total_tokens ?? 0) + (subagentUsage.total_tokens ?? 0),
                        };
                        stateUpdates.set(di, { ...candidate, usage_metadata: merged });
                        break;
                    }
                }
            }
        }
    }

    // 处理最后一条 AI 消息
    const last = messages[messages.length - 1];
    if (last.type !== "ai") {
        if (stateUpdates.size > 0) {
            return { messages: [...stateUpdates.values()].sort((a, b) => (a.id as string)?.localeCompare(b.id as string) ?? 0) };
        }
        return null;
    }

    // 记录 Token 用量日志
    const usage = last.usage_metadata as Record<string, unknown> | undefined;
    if (usage) {
        const inputDetail = usage.input_token_details as Record<string, unknown> | undefined;
        const outputDetail = usage.output_token_details as Record<string, unknown> | undefined;
        const detailParts: string[] = [];
        if (inputDetail) detailParts.push(`input_token_details=${JSON.stringify(inputDetail)}`);
        if (outputDetail) detailParts.push(`output_token_details=${JSON.stringify(outputDetail)}`);
        console.log(
            `LLM token usage: input=${usage.input_tokens ?? "?"} output=${usage.output_tokens ?? "?"} total=${usage.total_tokens ?? "?"}${detailParts.length > 0 ? " " + detailParts.join(" ") : ""}`,
        );
    }

    // 构建归因标签
    const normalTodos = _normalizeTodos(todos);
    const attribution = _buildAttribution(last, normalTodos);
    const additionalKwargs = { ...((last.additional_kwargs as Record<string, unknown>) ?? {}) };

    // 如果归因没变化，跳过
    if (JSON.stringify(additionalKwargs[TOKEN_USAGE_ATTRIBUTION_KEY]) === JSON.stringify(attribution)) {
        if (stateUpdates.size > 0) {
            return { messages: [...stateUpdates.values()].sort((a, b) => (a.id as string)?.localeCompare(b.id as string) ?? 0) };
        }
        return null;
    }

    additionalKwargs[TOKEN_USAGE_ATTRIBUTION_KEY] = attribution;
    const updatedMsg = { ...last, additional_kwargs: additionalKwargs };
    stateUpdates.set(messages.length - 1, updatedMsg);

    return {
        messages: [...stateUpdates.values()].sort((a, b) => {
            const aid = a.id as string | undefined;
            const bid = b.id as string | undefined;
            return (aid ?? "").localeCompare(bid ?? "");
        }),
    };
}

/**
 * 记录 Token 用量日志。
 */
export function logTokenUsage(usage: Record<string, unknown>): void {
    const input = usage.input_tokens ?? "?";
    const output = usage.output_tokens ?? "?";
    const total = usage.total_tokens ?? "?";
    console.log(`LLM token usage: input=${input} output=${output} total=${total}`);
}
