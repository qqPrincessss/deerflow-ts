/**
 * 写前读配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/read_before_write_config.py
 *
 * 写文件前必须先读过这个文件，防止盲写覆盖重要内容。
 */

import { z } from "zod";

export const ReadBeforeWriteConfigSchema = z.object({
    /** 开不开写前读检查 */
    enabled: z.boolean().default(true),
});

export type ReadBeforeWriteConfig = z.infer<typeof ReadBeforeWriteConfigSchema>;
