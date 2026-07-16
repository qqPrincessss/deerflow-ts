/**
 * 工具输出配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/tool_output_config.py
 *
 * 限制工具输出大小，防止撑爆上下文。
 */

import { z } from "zod";

export const ToolOutputConfigSchema = z.object({
    /** 开不开工具输出限制 */
    enabled: z.boolean().default(true),

    /** 触发磁盘外置的字符阈值 */
    externalize_min_chars: z.number().min(0).default(12000),

    /** 预览保留的头部字符数 */
    preview_head_chars: z.number().min(0).default(2000),

    /** 预览保留的尾部字符数 */
    preview_tail_chars: z.number().min(0).default(1000),

    /** 磁盘不可用时的最大字符数 */
    fallback_max_chars: z.number().min(0).default(30000),

    /** 回退截断的头部字符数 */
    fallback_head_chars: z.number().min(0).default(8000),

    /** 回退截断的尾部字符数 */
    fallback_tail_chars: z.number().min(0).default(3000),

    /** 持久化子目录 */
    storage_subdir: z.string().default(".tool-results"),

    /** 豁免工具列表（不参与预算限制） */
    exempt_tools: z.array(z.string()).default(["read_file", "read_file_tool"]),

    /** 每个工具的阈值覆盖 */
    tool_overrides: z.record(z.number()).default({}),
});

export type ToolOutputConfig = z.infer<typeof ToolOutputConfigSchema>;
