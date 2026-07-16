/**
 * 对话压缩配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/summarization_config.py
 *
 * 当对话太长时，用 LLM 把旧消息压缩成摘要，减少 token 消耗。
 */

import { z } from "zod";

/** 默认技能文件读取工具名 */
export const DEFAULT_SKILL_FILE_READ_TOOL_NAMES = ["read_file", "read", "view", "cat"];

/** 上下文大小类型 */
export const ContextSizeTypeSchema = z.enum(["fraction", "tokens", "messages"]);
export type ContextSizeType = z.infer<typeof ContextSizeTypeSchema>;

/** 上下文大小规格 */
export const ContextSizeSchema = z.object({
    type: ContextSizeTypeSchema,
    value: z.number(),
});
export type ContextSize = z.infer<typeof ContextSizeSchema>;

export const SummarizationConfigSchema = z.object({
    /** 开不开自动压缩 */
    enabled: z.boolean().default(false),

    /** 用哪个模型压缩（null 则用轻量模型） */
    model_name: z.string().nullable().default(null),

    /** 触发压缩的阈值（可以是多个，满足任一就触发） */
    trigger: z.union([ContextSizeSchema, z.array(ContextSizeSchema)]).nullable().default(null),

    /** 压缩后保留多少上下文 */
    keep: ContextSizeSchema.default({ type: "messages", value: 20 }),

    /** 准备压缩时最多保留多少 token */
    trim_tokens_to_summarize: z.number().nullable().default(4000),

    /** 自定义压缩提示模板 */
    summary_prompt: z.string().nullable().default(null),

    /** 技能文件读取工具名列表 */
    skill_file_read_tool_names: z.array(z.string()).default(DEFAULT_SKILL_FILE_READ_TOOL_NAMES),
});

export type SummarizationConfig = z.infer<typeof SummarizationConfigSchema>;
