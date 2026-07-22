/**
 * 子代理运行时配置定义。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/config.py
 *
 * 一个子代理就是一个独立的 Agent 实例。
 * 这个模块定义子代理长什么样（SubagentConfig），
 * 以及如何解析它应该用的模型（resolveSubagentModelName）。
 */

import { getAppConfig, type AppConfig } from "../config/app_config.js";

/**
 * 子代理配置。
 *
 * 主 Agent 派任务时，用这个配置创建一个子 Agent 实例。
 *
 * 字段说明：
 * - name: 唯一标识，比如 "web_searcher"、"code_analyzer"
 * - description: 什么时候该用这个子代理（给 LLM 看的）
 * - system_prompt: 子代理的系统提示词
 * - tools: 允许使用的工具列表。null = 继承主 Agent 的全部工具
 * - disallowed_tools: 禁止使用的工具（默认禁止 task，避免递归派生子代理）
 * - skills: 加载的技能。null = 继承全部启用技能，[] = 不加载技能
 * - model: "inherit" 表示用主 Agent 的模型
 * - max_turns: 最大对话轮次（默认 50）
 * - timeout_seconds: 超时秒数（默认 900 = 15 分钟）
 */
export interface SubagentConfig {
    name: string;
    description: string;
    system_prompt: string | null;
    tools: string[] | null;
    disallowed_tools: string[] | null;
    skills: string[] | null;
    model: string;
    max_turns: number;
    timeout_seconds: number;
}

/**
 * 从 AppConfig 取第一个模型的名称。
 */
function _firstModelName(appConfig: AppConfig): string {
    const models = (appConfig as Record<string, unknown>).models as Array<Record<string, unknown>> | undefined;
    if (!models || models.length === 0) {
        throw new Error("No chat models are configured. Please configure at least one model in config.yaml.");
    }
    return String(models[0].name);
}

/**
 * 解析子代理最终使用的模型名。
 *
 * 决策链：
 * 1. 子代理自己的 model 不是 "inherit" → 用自己的
 * 2. 有父 model → 继承父 model
 * 3. 都没有 → 用 AppConfig 的第一个模型
 *
 * @param config 子代理配置
 * @param parentModel 主 Agent 的模型名（可选）
 * @param appConfig 可选的 AppConfig（测试时注入用）
 */
export function resolveSubagentModelName(
    config: SubagentConfig,
    parentModel?: string | null,
    appConfig?: AppConfig | null,
): string {
    if (config.model !== "inherit") return config.model;
    if (parentModel) return parentModel;
    return _firstModelName(appConfig ?? getAppConfig());
}
