/**
 * Token 预算配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/token_budget_config.py
 *
 * 限制每次运行的最大 token 消耗，防止烧光额度。
 */

import { z } from "zod";

export const TokenBudgetConfigSchema = z.object({
    /** 开不开 token 预算限制 */
    enabled: z.boolean().default(false),

    /** 每次运行最大 token 数（输入+输出） */
    max_tokens: z.number().min(1000).default(200000),

    /** 输入 token 单独限制（可选） */
    max_input_tokens: z.number().min(1).nullable().default(null),

    /** 输出 token 单独限制（可选） */
    max_output_tokens: z.number().min(1).nullable().default(null),

    /** 警告阈值（0.8 = 80% 时警告） */
    warn_threshold: z.number().min(0).max(1).default(0.8),

    /** 强制停止阈值（1.0 = 100% 时停止） */
    hard_stop_threshold: z.number().min(0).max(1).default(1.0),
}).refine((data) => data.hard_stop_threshold >= data.warn_threshold, {
    message: "hard_stop_threshold must be >= warn_threshold",
});

export type TokenBudgetConfig = z.infer<typeof TokenBudgetConfigSchema>;
