/**
 * 安全防护提供者 — 可插拔的工具调用授权接口。
 *
 * 对应原项目：backend/packages/harness/deerflow/guardrails/provider.py
 *
 * 任何实现了 evaluate() / aevaluate() 方法的类都可以作为提供者。
 * 通过 resolve_variable() 按类路径加载，与 DeerFlow 的模型/工具/沙箱机制一致。
 */

import { type GuardrailRequest, type GuardrailDecision } from "./types.js";

export interface GuardrailProvider {
    name: string;

    /** 评估一个工具调用是否应该继续 */
    evaluate(request: GuardrailRequest): GuardrailDecision;

    /** 异步评估 */
    aevaluate(request: GuardrailRequest): Promise<GuardrailDecision>;
}
