/**
 * 子代理配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/subagents_config.py
 *
 * 子代理是主代理派出去执行任务的"同事"。
 * 配置决定并发限制、超时、模型等。
 */

import { z } from "zod";

/** 默认每轮最大子代理数 */
export const DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN = 6;

/** 最小子代理数 */
export const MIN_TOTAL_SUBAGENTS_PER_RUN = 1;

/** 最大子代理数 */
export const MAX_TOTAL_SUBAGENTS_PER_RUN = 50;

/** 最小并发数 */
export const MIN_CONCURRENT_SUBAGENT_CALLS = 2;

/** 最大并发数 */
export const MAX_CONCURRENT_SUBAGENT_CALLS = 4;

/**
 * 限制并发数到合法范围。
 */
export function clampSubagentConcurrency(value: number): number {
    return Math.max(MIN_CONCURRENT_SUBAGENT_CALLS, Math.min(MAX_CONCURRENT_SUBAGENT_CALLS, value));
}

/**
 * 限制每轮子代理总数到合法范围。
 */
export function clampTotalSubagentsPerRun(value: number): number {
    return Math.max(MIN_TOTAL_SUBAGENTS_PER_RUN, Math.min(MAX_TOTAL_SUBAGENTS_PER_RUN, value));
}

/** Token 预算配置 */
export const TokenBudgetConfigSchema = z.object({
    enabled: z.boolean().default(true),
    max_tokens: z.number().default(2_000_000),
    warn_threshold: z.number().default(0.7),
});
export type TokenBudgetConfig = z.infer<typeof TokenBudgetConfigSchema>;

/** 每个子代理的配置覆盖 */
export const SubagentOverrideConfigSchema = z.object({
    timeout_seconds: z.number().min(1).nullable().default(null),
    max_turns: z.number().min(1).nullable().default(null),
    model: z.string().min(1).nullable().default(null),
    skills: z.array(z.string()).nullable().default(null),
    token_budget: TokenBudgetConfigSchema.nullable().default(null),
});
export type SubagentOverrideConfig = z.infer<typeof SubagentOverrideConfigSchema>;

/** 用户自定义子代理类型 */
export const CustomSubagentConfigSchema = z.object({
    description: z.string(),
    system_prompt: z.string(),
    tools: z.array(z.string()).nullable().default(null),
    disallowed_tools: z.array(z.string()).default(["task", "ask_clarification", "present_files"]),
    skills: z.array(z.string()).nullable().default(null),
    model: z.string().default("inherit"),
    max_turns: z.number().min(1).default(50),
    timeout_seconds: z.number().min(1).default(900),
});
export type CustomSubagentConfig = z.infer<typeof CustomSubagentConfigSchema>;

/** 子代理系统主配置 */
export const SubagentsAppConfigSchema = z.object({
    /** 默认超时（秒） */
    timeout_seconds: z.number().min(1).default(1800),

    /** 默认最大轮次覆盖 */
    max_turns: z.number().min(1).nullable().default(null),

    /** 每轮最大子代理数 */
    max_total_per_run: z.number()
        .min(MIN_TOTAL_SUBAGENTS_PER_RUN)
        .max(MAX_TOTAL_SUBAGENTS_PER_RUN)
        .default(DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN),

    /** 默认 token 预算 */
    token_budget: TokenBudgetConfigSchema.default({
        enabled: true,
        max_tokens: 2_000_000,
        warn_threshold: 0.7,
    }),

    /** 每个子代理的配置覆盖 */
    agents: z.record(SubagentOverrideConfigSchema).default({}),

    /** 用户自定义子代理类型 */
    custom_agents: z.record(CustomSubagentConfigSchema).default({}),
});

export type SubagentsAppConfig = z.infer<typeof SubagentsAppConfigSchema>;
