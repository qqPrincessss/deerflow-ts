/**
 * 建议配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/suggestions_config.py
 *
 * 在 AI 回复后自动生成后续问题建议。
 */

import { z } from "zod";

export const SuggestionsConfigSchema = z.object({
    /** 开不开建议 */
    enabled: z.boolean().default(true),
});

export type SuggestionsConfig = z.infer<typeof SuggestionsConfigSchema>;
