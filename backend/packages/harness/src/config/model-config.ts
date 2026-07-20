/**
 * 模型配置 schema。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/model_config.py
 */

import { z } from "zod";

/**
 * 单个模型的配置。
 */
export const ModelConfigSchema = z.object({
    /** 模型唯一标识 */
    name: z.string(),
    /** 界面显示名 */
    display_name: z.string().optional(),
    /** 提供商类路径 */
    use: z.string(),
    /** 发给提供商的模型名 */
    model: z.string(),
    /** API key（支持 $ENV_VAR 解析） */
    api_key: z.string().optional(),
    /** OpenAI 兼容的 base URL */
    base_url: z.string().optional(),
    /** API 地址别名 */
    api_base: z.string().optional(),
    /** 最大生成 token 数 */
    max_tokens: z.number().optional(),
    /** 温度 */
    temperature: z.number().optional(),
    /** 是否支持推理模式 */
    supports_thinking: z.boolean().default(false),
    /** 是否支持图片理解 */
    supports_vision: z.boolean().default(false),
    /** 是否支持推理强度控制 */
    supports_reasoning_effort: z.boolean().default(false),
    /** thinking 启用时的配置覆盖 */
    when_thinking_enabled: z.record(z.unknown()).nullable().default(null),
    /** thinking 禁用时的配置覆盖 */
    when_thinking_disabled: z.record(z.unknown()).nullable().default(null),
    /** 快捷 thinking 配置 */
    thinking: z.record(z.unknown()).nullable().default(null),
    /** 使用 OpenAI Responses API */
    use_responses_api: z.boolean().optional(),
    /** 输出版本 */
    output_version: z.string().optional(),
    /** 定价配置 */
    pricing: z.record(z.unknown()).nullable().default(null),
}).passthrough();

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * 解析配置值。以 $ 开头的从环境变量读取。
 */
export function resolveConfigValue(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.startsWith("$")) return process.env[value.slice(1)];
    return value;
}
