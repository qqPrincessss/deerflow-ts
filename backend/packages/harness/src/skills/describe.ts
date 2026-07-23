/**
 * describe_skill — 延迟技能元数据检索。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/describe.py
 *
 * AI 通过 <skill_index> 看到技能名，调用 describe_skill 获取元数据
 * （描述、允许工具、文件路径），再决定是否 read_file 加载完整 SKILL.md。
 */

import { DEFAULT_SKILLS_CONTAINER_PATH } from "../constants.js";
import { SkillCategory } from "./types.js";
import { SkillCatalog } from "./catalog.js";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface SkillSearchSetup {
    describe_skill: ((name: string) => string) | null;
    skill_names: Set<string>;
}

// ════════════════════════════════════════════════════════════════════════════════
// HTML 转义
// ════════════════════════════════════════════════════════════════════════════════

function _htmlEscape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ════════════════════════════════════════════════════════════════════════════════
// 渲染
// ════════════════════════════════════════════════════════════════════════════════

function _renderSkillMetadata(skills: Array<{ name: string; description: string; category: SkillCategory; allowed_tools?: string[] | null; getContainerFilePath?: (base: string) => string }>, containerBasePath: string): string {
    const blocks: string[] = [];
    for (const s of skills) {
        const mutability = s.category === SkillCategory.CUSTOM ? "[custom, editable]" : "[built-in]";
        const toolsLine = s.allowed_tools?.join(", ") ?? "(all)";
        const location = s.getContainerFilePath?.(containerBasePath) ?? `${containerBasePath}/${s.category}/${s.name}/SKILL.md`;

        const name = _htmlEscape(s.name);
        const description = _htmlEscape(s.description);
        const tools = _htmlEscape(toolsLine);
        const loc = _htmlEscape(location);

        blocks.push(`## Skill: ${name}\n- Description: ${description} ${mutability}\n- Allowed tools: ${tools}\n- Location: ${loc}`);
    }
    return blocks.join("\n\n");
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建 describe_skill 工具
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 构建 describe_skill 工具函数。
 */
export function buildDescribeSkillTool(
    catalog: SkillCatalog,
    containerBasePath: string = DEFAULT_SKILLS_CONTAINER_PATH,
): (name: string) => string {
    return (name: string): string => {
        const matched = catalog.search(name);
        if (matched.length === 0) {
            return `No skills matched: ${name}`;
        }
        return _renderSkillMetadata(matched, containerBasePath);
    };
}

/**
 * 从技能列表构建技能搜索配置。
 */
export function buildSkillSearchSetup(
    skills: Array<{ name: string; description: string; category: SkillCategory; allowed_tools?: string[] | null; getContainerFilePath?: (base: string) => string }>,
    options?: {
        enabled?: boolean;
        containerBasePath?: string;
    },
): SkillSearchSetup {
    const { enabled = true, containerBasePath = DEFAULT_SKILLS_CONTAINER_PATH } = options ?? {};

    if (!enabled || skills.length === 0) {
        return { describe_skill: null, skill_names: new Set() };
    }

    const catalog = new SkillCatalog(skills as any[]);
    return {
        describe_skill: buildDescribeSkillTool(catalog, containerBasePath),
        skill_names: catalog.names,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// Prompt 渲染
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 生成 <skill_system> 块，包含名称索引。
 * AI 看到这个就知道有哪些技能可用，然后用 describe_skill 查详情。
 */
export function getSkillIndexPromptSection(options?: {
    skill_names?: Set<string>;
    containerBasePath?: string;
    skillEvolutionSection?: string;
}): string {
    const { skill_names, containerBasePath = DEFAULT_SKILLS_CONTAINER_PATH, skillEvolutionSection = "" } = options ?? {};

    if (!skill_names || skill_names.size === 0) return "";

    const names = [...skill_names].sort().map((n) => _htmlEscape(n)).join(", ");
    const evolution = skillEvolutionSection ? `\n${skillEvolutionSection}` : "";

    return `<skill_system>
You have access to skills that provide optimized workflows for specific tasks.

**Skill Discovery:**
1. Check <skill_index> for a skill name that matches your task
2. Call describe_skill(name) to fetch its description and capabilities
3. If the skill matches, call read_file on the returned location to load full instructions
4. Follow the skill's instructions precisely

**Explicit Slash Skill Activation:**
- If the user starts a request with \`/<skill-name>\`, that skill was explicitly requested.
- The runtime injects the activated skill content; do not call \`read_file\` for that SKILL.md again unless the injected skill references supporting resources you need.
${evolution}
<skill_index>
${names}
</skill_index>

Skills are located at: ${containerBasePath}
</skill_system>`;
}
