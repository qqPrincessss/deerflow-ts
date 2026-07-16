/**
 * 子代理状态契约 — 前后端共享的结果格式定义。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/status_contract.py
 *
 * 场景：主代理派了一个子代理去做任务。子代理完成后，要把结果告诉主代理和前端。
 *
 * 问题：结果怎么传？直接传一段文字？不行，因为：
 * - 前端需要知道状态（成功还是失败）
 * - 前端需要知道停止原因（是正常完成，还是被强制停止了）
 * - 前端需要知道用了多少 token（算成本）
 * - 前端需要知道用的什么模型（显示给用户）
 *
 * 解决：定义一个"契约"——所有子代理结果都按这个格式传。
 */

/** 状态 */
export const SUBAGENT_STATUS_KEY = "subagent_status";

/** 停止原因 */
export const SUBAGENT_STOP_REASON_KEY = "subagent_stop_reason";

/** 结果摘要 */
export const SUBAGENT_RESULT_BRIEF_KEY = "subagent_result_brief";

/** 结果哈希 */
export const SUBAGENT_RESULT_SHA256_KEY = "subagent_result_sha256";

/** 错误信息 */
export const SUBAGENT_ERROR_KEY = "subagent_error";

/** 用的什么模型 */
export const SUBAGENT_MODEL_NAME_KEY = "subagent_model_name";

/** token 用量 */
export const SUBAGENT_TOKEN_USAGE_KEY = "subagent_token_usage";
