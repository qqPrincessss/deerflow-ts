/**
 * 安全防护类型定义 — 工具调用的授权数据结构和决策结果。
 *
 * 对应原项目：backend/packages/harness/deerflow/guardrails/provider.py
 */

/** 传递给提供者的每个工具调用的上下文 */
export interface GuardrailRequest {
    tool_name: string;
    tool_input: Record<string, unknown>;
    agent_id?: string | null;
    thread_id?: string | null;
    is_subagent?: boolean;
    timestamp?: string;
    user_id?: string | null;
    user_role?: string | null;
    oauth_provider?: string | null;
    oauth_id?: string | null;
    run_id?: string | null;
    tool_call_id?: string | null;
}

/** 允许/拒绝决定的原因 */
export interface GuardrailReason {
    code: string;
    message?: string;
}

/** 提供者的允许/拒绝裁决 */
export interface GuardrailDecision {
    allow: boolean;
    reasons?: GuardrailReason[];
    policy_id?: string | null;
    metadata?: Record<string, unknown>;
}
