/**
 * 技能 frontmatter 校验工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/validation.py
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_MD_FILE } from "./types.js";
import { ALLOWED_FRONTMATTER_PROPERTIES, splitSkillMarkdown } from "./frontmatter.js";

/**
 * 校验技能目录的 SKILL.md frontmatter。
 *
 * @returns [isValid, message, skillName]
 */
export function validateSkillFrontmatter(skillDir: string): [boolean, string, string | null] {
    const skillMd = join(skillDir, SKILL_MD_FILE);
    if (!existsSync(skillMd)) {
        return [false, `${SKILL_MD_FILE} not found`, null];
    }

    let content: string;
    try {
        content = readFileSync(skillMd, "utf-8");
    } catch {
        return [false, `Failed to read ${SKILL_MD_FILE}`, null];
    }

    const [parts, error] = splitSkillMarkdown(content);
    if (error) return [false, error, null];
    if (!parts) return [false, "Invalid frontmatter format", null];

    const frontmatter = parts.metadata;

    // 检查不允许的属性
    const unexpectedKeys = Object.keys(frontmatter).filter(
        (k) => !ALLOWED_FRONTMATTER_PROPERTIES.has(k),
    );
    if (unexpectedKeys.length > 0) {
        return [false, `Unexpected key(s) in SKILL.md frontmatter: ${unexpectedKeys.sort().join(", ")}`, null];
    }

    // 检查必填字段
    if (!("name" in frontmatter)) return [false, "Missing 'name' in frontmatter", null];
    if (!("description" in frontmatter)) return [false, "Missing 'description' in frontmatter", null];

    // 校验 name
    const name = frontmatter.name;
    if (typeof name !== "string") return [false, `Name must be a string, got ${typeof name}`, null];

    const trimmedName = name.trim();
    if (!trimmedName) return [false, "Name cannot be empty", null];
    if (!/^[a-z0-9-]+$/.test(trimmedName)) {
        return [false, `Name '${trimmedName}' should be hyphen-case (lowercase letters, digits, and hyphens only)`, null];
    }
    if (trimmedName.startsWith("-") || trimmedName.endsWith("-") || trimmedName.includes("--")) {
        return [false, `Name '${trimmedName}' cannot start/end with hyphen or contain consecutive hyphens`, null];
    }
    if (trimmedName.length > 64) {
        return [false, `Name is too long (${trimmedName.length} characters). Maximum is 64 characters.`, null];
    }

    // 校验 description
    const description = frontmatter.description;
    if (typeof description !== "string") {
        return [false, `Description must be a string, got ${typeof description}`, null];
    }
    const trimmedDesc = description.trim();
    if (!trimmedDesc) {
        // 空描述也行，但必须存在
    }
    if (trimmedDesc.includes("<") || trimmedDesc.includes(">")) {
        return [false, "Description cannot contain angle brackets (< or >)", null];
    }
    if (trimmedDesc.length > 1024) {
        return [false, `Description is too long (${trimmedDesc.length} characters). Maximum is 1024 characters.`, null];
    }

    // allowed-tools 由 parser 校验
    // required-secrets 必须是列表
    const requiredSecrets = frontmatter["required-secrets"];
    if (requiredSecrets !== undefined && !Array.isArray(requiredSecrets)) {
        return [false, `required-secrets in ${SKILL_MD_FILE} must be a list`, null];
    }

    // secrets-autonomous 必须是布尔值
    const secretsAutonomous = frontmatter["secrets-autonomous"];
    if (secretsAutonomous !== undefined && typeof secretsAutonomous !== "boolean") {
        return [false, `secrets-autonomous in ${SKILL_MD_FILE} must be a boolean`, null];
    }

    return [true, "Skill is valid!", trimmedName];
}
