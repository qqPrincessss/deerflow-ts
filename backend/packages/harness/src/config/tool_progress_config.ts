/**
 * 工具进度配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/tool_progress_config.py
 *
 * 检测工具是否陷入停滞（反复调用但没有新信息）。
 */

import { z } from "zod";

export const ToolProgressConfigSchema = z.object({
    /** 开不开工具进度跟踪 */
    enabled: z.boolean().default(false),

    /** 连续问题调用几次后警告 */
    stagnation_threshold: z.number().min(1).default(3),

    /** 警告后几次升级到阻止 */
    warn_escalation_count: z.number().min(1).default(2),

    /** 是否注入进度评估提示 */
    inject_assessment: z.boolean().default(true),

    /** Jaccard 相似度阈值（检测近似重复结果） */
    jaccard_similarity_threshold: z.number().min(0).max(1).default(0.8),

    /** 应用相似度检查的最小词数 */
    min_word_count_for_similarity: z.number().default(10),

    /** 豁免工具列表 */
    exempt_tools: z.array(z.string()).default(["ask_clarification", "write_todos", "present_files", "task"]),

    /** 最多追踪几个线程的历史 */
    max_tracked_threads: z.number().min(1).default(100),
});

export type ToolProgressConfig = z.infer<typeof ToolProgressConfigSchema>;
