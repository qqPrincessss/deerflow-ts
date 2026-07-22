/**
 * 斜杠技能命令解析。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/slash.py
 */

import { DEFAULT_SKILLS_CONTAINER_PATH } from "../constants.js";
import { type Skill, getSkillContainerFilePath } from "./types.js";

/** 保留的斜杠命令（不可用作技能名） */
export const RESERVED_SLASH_SKILL_NAMES = new Set([
    "bootstrap", "goal", "help", "memory", "models", "new", "status",
]);

/** 斜杠技能命令正则：/skill-name 剩余文本 */
const _SLASH_SKILL_RE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+|$)/;

/** 解析后的斜杠技能引用 */
export interface SlashSkillReference {
    name: string;
    remaining_text: string;
}

/** 已解析的斜杠技能激活 */
export interface ResolvedSlashSkill {
    skill: Skill;
    remaining_text: string;
    container_file_path: string;
}

/**
 * 解析严格的 /skill-name 语法，忽略保留控制命令。
 */
export function parseSlashSkillReference(text: string): SlashSkillReference | null {
    const match = _SLASH_SKILL_RE.exec(text);
    if (!match) return null;

    const name = match[1];
    if (RESERVED_SLASH_SKILL_NAMES.has(name)) return null;

    return {
        name,
        remaining_text: text.slice(match.index + match[0].length).trimStart(),
    };
}

/**
 * 将文本解析为已启用的、在白名单中的技能激活。
 */
export function resolveSlashSkill(
    text: string,
    skills: Skill[],
    options?: {
        available_skills?: Set<string> | null;
        container_base_path?: string;
    },
): ResolvedSlashSkill | null {
    const { available_skills, container_base_path = DEFAULT_SKILLS_CONTAINER_PATH } = options ?? {};

    const reference = parseSlashSkillReference(text);
    if (reference === null) return null;
    if (available_skills && !available_skills.has(reference.name)) return null;

    const skill = skills.find(
        (s) => s.name === reference.name && s.enabled,
    );
    if (!skill) return null;

    return {
        skill,
        remaining_text: reference.remaining_text,
        container_file_path: getSkillContainerFilePath(skill, container_base_path),
    };
}
