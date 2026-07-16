/**
 * 循环检测配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/loop_detection_config.py
 *
 * 检测 LLM 是否陷入工具调用循环，防止烧光 token。
 */

import { z } from "zod";

/** 每个工具的频率阈值覆盖 */
export const ToolFreqOverrideSchema = z.object({
    warn: z.number().min(1),
    hard_limit: z.number().min(1),
}).refine((data) => data.hard_limit >= data.warn, {
    message: "hard_limit must be >= warn",
});
export type ToolFreqOverride = z.infer<typeof ToolFreqOverrideSchema>;

export const LoopDetectionConfigSchema = z.object({
    /** 开不开循环检测 */
    enabled: z.boolean().default(true),

    /** 相同调用几次后警告 */
    warn_threshold: z.number().min(1).default(3),

    /** 相同调用几次后强制停止 */
    hard_limit: z.number().min(1).default(5),

    /** 滑动窗口大小（记录最近几次调用） */
    window_size: z.number().min(1).default(20),

    /** 最多追踪几个线程的历史 */
    max_tracked_threads: z.number().min(1).default(100),

    /** 同工具类型几次后警告 */
    tool_freq_warn: z.number().min(1).default(30),

    /** 同工具类型几次后强制停止 */
    tool_freq_hard_limit: z.number().min(1).default(50),

    /** 每个工具的频率阈值覆盖 */
    tool_freq_overrides: z.record(ToolFreqOverrideSchema).default({}),
}).refine((data) => data.hard_limit >= data.warn_threshold, {
    message: "hard_limit must be >= warn_threshold",
}).refine((data) => data.tool_freq_hard_limit >= data.tool_freq_warn, {
    message: "tool_freq_hard_limit must be >= tool_freq_warn",
});

export type LoopDetectionConfig = z.infer<typeof LoopDetectionConfigSchema>;
