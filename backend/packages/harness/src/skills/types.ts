/**
 * 技能类型定义。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/types.py
 */

import { DEFAULT_SKILLS_CONTAINER_PATH } from "../constants.js";

export const SKILL_MD_FILE = "SKILL.md";

/** 技能分类 */
export enum SkillCategory {
    PUBLIC = "public",
    CUSTOM = "custom",
    LEGACY = "legacy",
}

/** 技能声明的请求级密钥需求 */
export interface SecretRequirement {
    
    name: string;
    optional?: boolean;
}

/** 技能 */
export interface Skill {
    name: string;
    description: string;
    license: string | null;
    skill_dir: string;
    skill_file: string;
    relative_path: string;
    category: SkillCategory;
    allowed_tools?: string[] | null;
    enabled: boolean;
    required_secrets?: SecretRequirement[];
    /** 自动驾驶模式下是否允许绑定密钥（secrets-autonomous frontmatter） */
    secrets_autonomous?: boolean;
}

/** 获取技能在容器中的目录路径 */
export function getSkillContainerPath(
    skill: Skill,
    containerBasePath: string = DEFAULT_SKILLS_CONTAINER_PATH,
): string {
    const categoryBase = `${containerBasePath}/${skill.category}`;
    if (skill.relative_path) {
        return `${categoryBase}/${skill.relative_path}`;
    }
    return categoryBase;
}

/** 获取技能 SKILL.md 在容器中的路径 */
export function getSkillContainerFilePath(
    skill: Skill,
    containerBasePath: string = DEFAULT_SKILLS_CONTAINER_PATH,
): string {
    return `${getSkillContainerPath(skill, containerBasePath)}/SKILL.md`;
}
