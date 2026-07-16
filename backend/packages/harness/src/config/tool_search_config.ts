/**
 * 工具搜索配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/tool_search_config.py
 *
 * 延迟加载 MCP 工具，通过 tool_search 工具在运行时发现。
 */

import { z } from "zod";

/** 自动提升最小值 */
export const AUTO_PROMOTE_TOP_K_MIN = 1;

/** 自动提升最大值 */
export const AUTO_PROMOTE_TOP_K_MAX = 5;

/**
 * 限制自动提升数量到合法范围。
 */
export function clampAutoPromoteTopK(value: number): number {
    return Math.max(AUTO_PROMOTE_TOP_K_MIN, Math.min(AUTO_PROMOTE_TOP_K_MAX, Math.floor(value)));
}

export const ToolSearchConfigSchema = z.object({
    /** 开不开延迟工具加载 */
    enabled: z.boolean().default(false),

    /** 每次模型调用自动提升的 MCP 工具数量 */
    auto_promote_top_k: z.number()
        .min(AUTO_PROMOTE_TOP_K_MIN)
        .max(AUTO_PROMOTE_TOP_K_MAX)
        .default(3),
});

export type ToolSearchConfig = z.infer<typeof ToolSearchConfigSchema>;
