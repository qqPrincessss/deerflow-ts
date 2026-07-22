/**
 * 私有运行时上下文 key，由 DeerFlow 运行时组件共享。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/context_keys.py
 */

/**
 * 当前运行之前已存在的消息 ID key。
 *
 * 用于区分中断前的旧消息和恢复后的新消息。
 */
export const CURRENT_RUN_PRE_EXISTING_MESSAGE_IDS_KEY = "__deerflow_pre_run_message_ids" as const;