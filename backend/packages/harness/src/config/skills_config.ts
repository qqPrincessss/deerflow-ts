/**
 * 技能配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/skills_config.py
 *
 * 技能是 Agent 可以加载的指令包（SKILL.md 文件）。
 */

import { z } from "zod";
import { DEFAULT_SKILLS_CONTAINER_PATH } from "../constants.js";

export const SkillsConfigSchema = z.object({
    /** 技能存储类路径 */
    use: z.string().default("deerflow.skills.storage.local_skill_storage:LocalSkillStorage"),

    /** 技能目录路径（null 则用默认路径） */
    path: z.string().nullable().default(null),

    /** 沙箱容器内的技能路径 */
    container_path: z.string().default(DEFAULT_SKILLS_CONTAINER_PATH),

    /** 延迟发现模式（true 时不注入完整元数据，只注入名字） */
    deferred_discovery: z.boolean().default(false),
});

export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
