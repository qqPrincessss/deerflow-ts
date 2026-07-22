/**
 * 澄清工具 — 当需要用户输入时使用。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/builtins/clarification_tool.py
 *
 * 这个工具本身是占位实现，实际逻辑由 ClarificationMiddleware 拦截处理。
 */

export type ClarificationType =
    | "missing_info"
    | "ambiguous_requirement"
    | "approach_choice"
    | "risk_confirmation"
    | "suggestion";

export interface AskClarificationParams {
    /** 询问用户的问题 */
    question: string;
    /** 澄清类型 */
    clarification_type: ClarificationType;
    /** 可选的上下文说明 */
    context?: string;
    /** 可选的选择列表（用于 approach_choice 或 suggestion） */
    options?: string[];
}

/**
 * 询问用户澄清。
 * 实际由 ClarificationMiddleware 拦截，暂停执行并等待用户回复。
 */
export function askClarification(params: AskClarificationParams): string {
    return "Clarification request processed by middleware";
}
