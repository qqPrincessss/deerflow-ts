/**
 * 终端响应中间件 — 确保工具调用后的回合以可见的 AI 回复结束。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/terminal_response_middleware.py
 *
 * 问题：AI 调了工具后，有时返回空消息（无文字、无工具调用）。
 * 解决：
 *   第一次：删除空消息，注入恢复提示，跳回模型
 *   第二次：替换为降级错误消息
 */

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _RECOVERY_PROMPT = [
    "<system_reminder>",
    "Your previous response after the tool execution was empty. Review the tool results ",
    "already present in the conversation and provide a concise, user-visible final response. ",
    "Do not call another tool unless it is strictly necessary.",
    "</system_reminder>",
].join("\n");

const _FALLBACK_CONTENT = "The model completed the tool run but returned no final response, including after one automatic retry. Please try again or use a different model.";

const _TOOL_CALL_FINISH_REASONS = new Set(["tool_calls", "function_call"]);

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _hasVisibleContent(message: Record<string, unknown>): boolean {
    const content = message.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (typeof block === "string" && block.trim()) return true;
            if (typeof block === "object" && block !== null) {
                const b = block as Record<string, unknown>;
                if (b.type === "text" || b.type === "output_text") {
                    if (typeof b.text === "string" && b.text.trim()) return true;
                }
            }
        }
    }
    return false;
}

function _hasToolCallIntent(message: Record<string, unknown>): boolean {
    const toolCalls = message.tool_calls as Array<unknown> | undefined;
    if (toolCalls && toolCalls.length > 0) return true;
    if ((message as Record<string, unknown>).invalid_tool_calls) return true;

    const kwargs = (message.additional_kwargs as Record<string, unknown>) ?? {};
    if (kwargs.tool_calls || kwargs.function_call) return true;

    const responseMetadata = (message.response_metadata as Record<string, unknown>) ?? {};
    return _TOOL_CALL_FINISH_REASONS.has(responseMetadata.finish_reason as string);
}

function _toolResultInCurrentTurn(messages: Array<Record<string, unknown>>): boolean {
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.type !== "human") continue;
        if ((msg.additional_kwargs as Record<string, unknown>)?.hide_from_ui) continue;
        lastUserIdx = i;
    }
    if (lastUserIdx === -1) return false;
    for (let i = lastUserIdx + 1; i < messages.length; i++) {
        if (messages[i].type === "tool") return true;
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════════
// TerminalResponseTracker
// ════════════════════════════════════════════════════════════════════════════════

const _MAX_ENTRIES = 1000;

export class TerminalResponseTracker {
    private _retryCounts = new Map<string, number>();
    private _pendingPrompts = new Map<string, boolean>();

    private _key(threadId: string, runId: string): string {
        return `${threadId}:${runId}`;
    }

    private _setWithCap<T>(map: Map<string, T>, key: string, value: T): void {
        if (map.size >= _MAX_ENTRIES) {
            const first = map.keys().next().value;
            if (first !== undefined) map.delete(first);
        }
        map.set(key, value);
    }

    clear(threadId: string, runId: string): void {
        const key = this._key(threadId, runId);
        this._retryCounts.delete(key);
        this._pendingPrompts.delete(key);
    }

    clearOtherRuns(threadId: string, currentRunId: string): void {
        const prefix = `${threadId}:`;
        for (const key of this._retryCounts.keys()) {
            if (key.startsWith(prefix) && key !== `${threadId}:${currentRunId}`) {
                this._retryCounts.delete(key);
                this._pendingPrompts.delete(key);
            }
        }
    }

    beforeAgent(threadId: string, runId: string): void {
        // 清除其他 run 的状态
        this.clearOtherRuns(threadId, runId);
        // 清除当前 run 的状态（处理 Command(goto=END) 绕过 after_agent 的情况）
        this.clear(threadId, runId);
    }

    /**
     * 检查是否需要恢复空消息。
     *
     * @returns { stateUpdate, jumpToModel } 或 null
     */
    apply(
        messages: Array<Record<string, unknown>>,
        threadId: string,
        runId: string,
    ): Record<string, unknown> | null {
        if (!messages || messages.length === 0) return null;
        const last = messages[messages.length - 1];
        if (last.type !== "ai") return null;

        // 有可见内容或有工具调用意图 → 正常
        if (_hasVisibleContent(last) || _hasToolCallIntent(last)) return null;
        // 当前回合没有工具结果 → 不需要恢复
        if (!_toolResultInCurrentTurn(messages)) return null;

        const key = this._key(threadId, runId);
        const retryCount = this._retryCounts.get(key) ?? 0;

        if (retryCount === 0) {
            // 第一次空响应：入队恢复提示，删除空消息，跳回模型
            this._setWithCap(this._retryCounts, key, 1);
            this._setWithCap(this._pendingPrompts, key, true);

            const lastMsgId = last.id as string | undefined;
            const result: Record<string, unknown> = { jump_to: "model" };
            if (lastMsgId) {
                result.messages = [{ type: "remove", id: lastMsgId }];
            }
            return result;
        }

        // 第二次空响应：替换为降级消息
        const kwargs = { ...((last.additional_kwargs as Record<string, unknown>) ?? {}) };
        kwargs.deerflow_error_fallback = true;
        kwargs.error_reason = "Model returned an empty terminal response after one retry";

        return {
            messages: [{
                ...last,
                content: _FALLBACK_CONTENT,
                additional_kwargs: kwargs,
            }],
        };
    }

    /**
     * 获取并清空待发送的恢复提示。
     */
    drainPendingPrompt(threadId: string, runId: string): boolean {
        const key = this._key(threadId, runId);
        const pending = this._pendingPrompts.get(key) ?? false;
        this._pendingPrompts.delete(key);
        return pending;
    }

    /**
     * 在模型请求中注入恢复提示。
     */
    augmentRequest(
        messages: Array<Record<string, unknown>>,
        threadId: string,
        runId: string,
    ): Array<Record<string, unknown>> | null {
        const pending = this.drainPendingPrompt(threadId, runId);
        if (!pending) return null;

        return [
            ...messages,
            {
                type: "human",
                content: _RECOVERY_PROMPT,
                name: "terminal_response_recovery",
                additional_kwargs: { hide_from_ui: true },
            },
        ];
    }
}
