/**
 * 安全终止配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/safety_finish_reason_config.py
 *
 * 当 LLM 提供商因安全原因终止响应时（如内容过滤），抑制工具调用。
 */

import { z } from "zod";

/** 安全检测器配置 */
export const SafetyDetectorConfigSchema = z.object({
    /** 检测器类路径 */
    use: z.string(),
    /** 构造函数参数 */
    config: z.record(z.unknown()).default({}),
});
export type SafetyDetectorConfig = z.infer<typeof SafetyDetectorConfigSchema>;

export const SafetyFinishReasonConfigSchema = z.object({
    /** 开不开安全终止检测 */
    enabled: z.boolean().default(true),

    /** 自定义检测器列表（null 则用内置检测器） */
    detectors: z.array(SafetyDetectorConfigSchema).nullable().default(null),
});

export type SafetyFinishReasonConfig = z.infer<typeof SafetyFinishReasonConfigSchema>;
