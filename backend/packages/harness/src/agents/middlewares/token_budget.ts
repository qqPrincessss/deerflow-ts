/**
 * Token 预算中间件 — 限制每次运行中的 Token 用量。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/token_budget_middleware.py
 *
 * 两重限制：
 *   1. 软警告：用量达到 warn_threshold → 通知 AI "快收尾"
 *   2. 硬停止：用量达到 hard_stop_threshold → 去掉工具调用，强制产出
 *
 * 支持总 Token、输入 Token、输出 Token 三种维度的独立预算。
 * 硬停止记录 stop_reason="token_capped" 供执行器读取。
 */

import { type TokenBudgetConfig } from "../../config/token_budget_config.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _BUDGET_WARNING_MSG =
    "[TOKEN BUDGET WARNING] You have used {used:,} of your {budget:,} {reason} token budget ({percent:.0f}%). Wrap up your current work and produce a final answer. Avoid starting new tool calls unless absolutely necessary.";

const _BUDGET_EXCEEDED_MSG =
    "[TOKEN BUDGET EXCEEDED] The {reason} token usage ({used:,}) has exceeded the safety limit ({budget:,}). Producing final answer with results collected so far.";

// ════════════════════════════════════════════════════════════════════════════════
// TokenBudgetTracker
// ════════════════════════════════════════════════════════════════════════════════

export class TokenBudgetTracker {
    private _config: TokenBudgetConfig;
    /** per-run_id → 是否已经警告过 */
    private _warned: Map<string, boolean> = new Map();
    /** per-run_id → 待发送警告列表 */
    private _pendingWarnings: Map<string, string[]> = new Map();
    /** per-run_id → message_id → (input, output) 已记录的用量 */
    private _seenMessages: Map<string, Map<string, [number, number]>> = new Map();
    /** per-run_id → 累积用量 */
    private _cumulativeUsage: Map<string, { input: number; output: number; total: number }> = new Map();
    /** per-run_id → stop_reason */
    private _stopReason: Map<string, string> = new Map();

    private readonly _maxEntries = 1000;

    constructor(config: TokenBudgetConfig) {
        this._config = config;
    }

    consumeStopReason(runId: string | null): string | null {
        const key = runId ?? "null";
        const reason = this._stopReason.get(key);
        this._stopReason.delete(key);
        return reason ?? null;
    }

    reset(): void {
        this._warned.clear();
        this._pendingWarnings.clear();
        this._seenMessages.clear();
        this._cumulativeUsage.clear();
        this._stopReason.clear();
    }

    private _clearRunState(runId: string): void {
        this._warned.delete(runId);
        this._pendingWarnings.delete(runId);
        this._seenMessages.delete(runId);
        this._cumulativeUsage.delete(runId);
    }

    // ── 预算控制（每 Map 限制 1000 条，防止内存泄漏） ──────────────

    private _setWithCap<T>(map: Map<string, T>, key: string, value: T): void {
        if (map.size >= this._maxEntries) {
            const first = map.keys().next().value;
            if (first !== undefined) map.delete(first);
        }
        map.set(key, value);
    }

    // ── 样式辅助 ──────────────────────────────────────────────

    private static _appendText(content: unknown, stopMsg: string): unknown {
        if (content === null || content === undefined) return stopMsg;
        if (typeof content === "string") return content ? `${content}\n\n${stopMsg}` : `\n\n${stopMsg}`;
        if (Array.isArray(content)) return [...content, { type: "text", text: `\n\n${stopMsg}` }];
        return `${content}\n\n${stopMsg}`;
    }

    private static _buildHardStopUpdate(
        lastMsg: Record<string, unknown>,
        stopMsg: string,
    ): Record<string, unknown> {
        const updatedContent = TokenBudgetTracker._appendText(lastMsg.content, stopMsg);
        const kwargs = { ...((lastMsg.additional_kwargs as Record<string, unknown>) ?? {}) };
        delete kwargs.tool_calls;
        delete kwargs.function_call;

        const responseMetadata = { ...((lastMsg.response_metadata as Record<string, unknown>) ?? {}) };
        if (responseMetadata.finish_reason === "tool_calls") {
            responseMetadata.finish_reason = "stop";
        }

        return {
            content: updatedContent,
            tool_calls: [],
            additional_kwargs: kwargs,
            response_metadata: responseMetadata,
        };
    }

    // ── Agent 运行前：标记已有消息为"已见过" ──────────────────

    beforeAgent(messages: Array<Record<string, unknown>>, runId: string): void {
        if (!this._config.enabled) return;
        if (!messages || messages.length === 0) return;

        let seen = this._seenMessages.get(runId);
        if (!seen) {
            seen = new Map();
            this._setWithCap(this._seenMessages, runId, seen);
        }
        if (!this._cumulativeUsage.has(runId)) {
            this._cumulativeUsage.set(runId, { input: 0, output: 0, total: 0 });
        }

        for (const msg of messages) {
            if (msg.type !== "ai" || !msg.id) continue;
            const usage = msg.usage_metadata as Record<string, unknown> | undefined;
            if (!usage) continue;
            const inputTokens = (usage.input_tokens as number) ?? 0;
            const outputTokens = (usage.output_tokens as number) ?? 0;
            seen.set(msg.id as string, [inputTokens, outputTokens]);
        }
    }

    // ── Agent 运行后：清理状态 ──────────────────────────────

    afterAgent(runId: string): void {
        if (!this._config.enabled) return;
        this._clearRunState(runId);
    }

    // ── 模型调用后：检测用量 ──────────────────────────────

    apply(
        messages: Array<Record<string, unknown>>,
        runId: string,
    ): Record<string, unknown> | null {
        if (!this._config.enabled) return null;
        if (!messages || messages.length === 0) return null;

        const lastMsg = messages[messages.length - 1];
        if (lastMsg.type !== "ai") return null;

        let seen = this._seenMessages.get(runId);
        if (!seen) {
            seen = new Map();
            this._setWithCap(this._seenMessages, runId, seen);
        }
        let usageAccum = this._cumulativeUsage.get(runId);
        if (!usageAccum) {
            usageAccum = { input: 0, output: 0, total: 0 };
            this._cumulativeUsage.set(runId, usageAccum);
        }

        // 计算新增用量（处理子代理的追溯 Token）
        for (const msg of messages) {
            if (msg.type !== "ai" || !msg.id) continue;
            const usage = msg.usage_metadata as Record<string, unknown> | undefined;
            if (!usage) continue;

            const inputTokens = (usage.input_tokens as number) ?? 0;
            const outputTokens = (usage.output_tokens as number) ?? 0;
            const prev = seen.get(msg.id as string);
            const prevInput = prev?.[0] ?? 0;
            const prevOutput = prev?.[1] ?? 0;
            const diffInput = Math.max(0, inputTokens - prevInput);
            const diffOutput = Math.max(0, outputTokens - prevOutput);

            if (diffInput > 0 || diffOutput > 0) {
                usageAccum.input += diffInput;
                usageAccum.output += diffOutput;
                usageAccum.total += diffInput + diffOutput;
                seen.set(msg.id as string, [inputTokens, outputTokens]);
            }
        }

        if (usageAccum.total <= 0) return null;

        const config = this._config;
        const fractions: Array<[string, number, number]> = [
            ["total", usageAccum.total, config.max_tokens],
        ];
        if (config.max_input_tokens) {
            fractions.push(["input", usageAccum.input, config.max_input_tokens]);
        }
        if (config.max_output_tokens) {
            fractions.push(["output", usageAccum.output, config.max_output_tokens]);
        }

        let highestFrac = 0;
        let triggerReason = "";
        let triggerUsed = 0;
        let triggerBudget = 0;

        for (const [reason, used, limit] of fractions) {
            const frac = used / limit;
            if (frac > highestFrac) {
                highestFrac = frac;
                triggerReason = reason;
                triggerUsed = used;
                triggerBudget = limit;
            }
        }

        // 硬停止
        if (highestFrac >= (config.hard_stop_threshold ?? 1.0)) {
            this._setWithCap(this._stopReason, runId, "token_capped");
            const stopText = _BUDGET_EXCEEDED_MSG
                .replace("{reason}", triggerReason)
                .replace("{used}", triggerUsed.toLocaleString())
                .replace("{budget}", triggerBudget.toLocaleString());
            const update = TokenBudgetTracker._buildHardStopUpdate(lastMsg, stopText);
            return { messages: [{ ...lastMsg, ...update }] };
        }

        // 软警告
        const warned = this._warned.get(runId);
        if (highestFrac >= (config.warn_threshold ?? 0.7) && !warned) {
            this._setWithCap(this._warned, runId, true);
            const percent = highestFrac * 100;
            const warnText = _BUDGET_WARNING_MSG
                .replace("{reason}", triggerReason)
                .replace("{used}", triggerUsed.toLocaleString())
                .replace("{budget}", triggerBudget.toLocaleString())
                .replace("{percent}", `${percent.toFixed(0)}`);
            const warnings = this._pendingWarnings.get(runId) ?? [];
            warnings.push(warnText);
            this._setWithCap(this._pendingWarnings, runId, warnings);
            return null;
        }

        return null;
    }

    // ── 模型调用前：注入警告 ──────────────────────────────

    drainPendingWarnings(runId: string): string[] {
        if (!this._config.enabled) return [];
        const warnings = this._pendingWarnings.get(runId) ?? [];
        this._pendingWarnings.delete(runId);
        return warnings;
    }

    injectWarnings(messages: Array<Record<string, unknown>>, warnings: string[]): Array<Record<string, unknown>> | null {
        if (warnings.length === 0) return null;
        return [
            ...messages,
            {
                type: "human",
                content: warnings.join("\n\n"),
                name: "budget_warning",
            },
        ];
    }
}
