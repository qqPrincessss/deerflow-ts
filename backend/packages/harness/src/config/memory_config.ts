/**
 * 记忆系统配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/memory_config.py
 *
 * 记忆系统从对话中提炼关键事实，跨对话保留。
 * 下次对话时注入系统提示，让 Agent "记住"用户偏好。
 */

import { z } from "zod";

export const MemoryConfigSchema = z.object({
    /** 开不开记忆 */
    enabled: z.boolean().default(true),

    /** 存储路径（空则用默认的 per-user 路径） */
    storage_path: z.string().default(""),

    /** 存储类路径 */
    storage_class: z.string().default("deerflow.agents.memory.storage.FileMemoryStorage"),

    /** 去抖秒数（等多久再处理队列） */
    debounce_seconds: z.number().min(1).max(300).default(30),

    /** 用哪个模型（null 则用默认模型） */
    model_name: z.string().nullable().default(null),

    /** 最大事实数 */
    max_facts: z.number().min(10).max(500).default(100),

    /** 置信度阈值（低于这个值不存） */
    fact_confidence_threshold: z.number().min(0).max(1).default(0.7),

    /** 操作模式：middleware（被动）或 tool（主动） */
    mode: z.enum(["middleware", "tool"]).default("middleware"),

    /** 注入开关（要不要把记忆注入系统提示） */
    injection_enabled: z.boolean().default(true),

    /** 注入最大 token 数 */
    max_injection_tokens: z.number().min(100).max(8000).default(2000),

    /** 计数策略：tiktoken（准确）或 char（免网络） */
    token_counting: z.enum(["tiktoken", "char"]).default("tiktoken"),

    /** 保证注入的类别（这些类别的事实总是注入） */
    guaranteed_categories: z.array(z.string()).default(["correction"]),

    /** 保证注入的 token 预算 */
    guaranteed_token_budget: z.number().min(50).max(2000).default(500),

    // ── 过期审查 ────────────────────────────────────────────────

    /** 过期审查开关 */
    staleness_review_enabled: z.boolean().default(true),

    /** 过期天数（超过这个天数的事实要审查） */
    staleness_age_days: z.number().min(30).max(365).default(90),

    /** 最小候选数（少于这个数不触发审查） */
    staleness_min_candidates: z.number().min(1).max(50).default(3),

    /** 每轮最大删除数 */
    staleness_max_removals_per_cycle: z.number().min(1).max(50).default(10),

    /** 保护类别（这些类别的事实不被过期审查删除） */
    staleness_protected_categories: z.array(z.string()).default(["correction"]),

    // ── 事实合并 ────────────────────────────────────────────────

    /** 合并开关 */
    consolidation_enabled: z.boolean().default(false),

    /** 合并最小事实数（少于这个数不触发合并） */
    consolidation_min_facts: z.number().min(3).max(30).default(8),

    /** 每轮最大合并组数 */
    consolidation_max_groups_per_cycle: z.number().min(1).max(10).default(3),

    /** 每组最大源事实数 */
    consolidation_max_sources: z.number().min(2).max(20).default(8),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/**
 * 判断是否应该使用记忆工具模式。
 */
export function shouldUseMemoryTools(config: MemoryConfig): boolean {
    return config.enabled && config.mode === "tool";
}
