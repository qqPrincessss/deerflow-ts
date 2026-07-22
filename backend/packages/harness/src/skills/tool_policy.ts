/**
 * 技能工具策略 — 按技能声明的工具白名单过滤工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/tool_policy.py
 */

import { type Skill } from "./types.js";

/** 即使技能声明了 allowed_tools，这些内置工具始终可用 */
export const ALWAYS_AVAILABLE_BUILTIN_TOOL_NAMES = new Set(["read_file", "review_skill_package"]);

/**
 * 返回所有技能声明的 allowed_tools 的并集。
 * 没有任何技能声明 allowed_tools 时返回 null（表示全部允许）。
 */
export function allowedToolNamesForSkills(skills: Skill[]): Set<string> | null {
    if (skills.length === 0) return null;

    const allowed = new Set<string>();
    let hasExplicitDeclaration = false;

    for (const skill of skills) {
        if (skill.allowed_tools === null || skill.allowed_tools === undefined) continue;
        hasExplicitDeclaration = true;
        for (const tool of skill.allowed_tools) {
            allowed.add(tool);
        }
    }

    if (!hasExplicitDeclaration) return null;
    return allowed;
}

/**
 * 根据技能声明过滤工具。
 */
export function filterToolsBySkillAllowedTools<T extends { name: string }>(
    tools: T[],
    skills: Skill[],
    alwaysAllowedToolNames?: Set<string>,
): T[] {
    const allowed = allowedToolNamesForSkills(skills);
    if (allowed === null) return tools;

    const allowedWithBuiltins = new Set([
        ...allowed,
        ...ALWAYS_AVAILABLE_BUILTIN_TOOL_NAMES,
        ...(alwaysAllowedToolNames ?? []),
    ]);

    return tools.filter((t) => allowedWithBuiltins.has(t.name));
}
