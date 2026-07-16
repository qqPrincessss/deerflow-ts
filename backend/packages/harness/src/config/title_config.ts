/**
 * 标题生成配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/title_config.py
 *
 * Agent 执行完后，自动生成对话标题。
 */

import { z } from "zod";

export const TitleConfigSchema = z.object({
    /** 开不开自动标题生成 */
    enabled: z.boolean().default(true),

    /** 标题最大词数 */
    max_words: z.number().min(1).max(20).default(6),

    /** 标题最大字符数 */
    max_chars: z.number().min(10).max(200).default(60),

    /** 用哪个模型生成标题（null 则用本地回退） */
    model_name: z.string().nullable().default(null),

    /** 提示模板 */
    prompt_template: z.string().default(
        "Generate a concise title (max {max_words} words) for this conversation.\n" +
        "User: {user_msg}\nAssistant: {assistant_msg}\n\n" +
        "Return ONLY the title, no quotes, no explanation."
    ),
});

export type TitleConfig = z.infer<typeof TitleConfigSchema>;
