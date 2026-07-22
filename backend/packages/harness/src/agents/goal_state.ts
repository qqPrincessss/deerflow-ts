/**
 * 目标状态类型定义。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/goal_state.py
 */

/** 目标卡住的原因类型 */
export type GoalBlocker = "none" | "missing_evidence" | "needs_user_input" | "run_failed" | "external_wait" | "goal_not_met_yet";

export interface GoalEvaluation {
      satisfied: boolean;
      blocker: GoalBlocker;
      reason: string;
      evidence_summary?: string;  // ? 就是 NotRequired
}
export interface GoalState {
    objective:string,
    status:"active",
    created_at:string,
    updated_at:string,
    continuation_count: number,
    max_continuations: number,
    no_progress_count: number,
    max_no_progress_continuations: number
    last_evaluation?: Record<string,unknown>;
}