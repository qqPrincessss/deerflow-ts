/**
 * SKILL.md frontmatter 解析工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/frontmatter.py
 *
 * 运行时解析器、安装时校验器和 review 核心都使用这个模块
 * 作为 DeerFlow SKILL.md 元数据的 schema 来源。
 */

import { parse as parseYaml } from "yaml";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

export const ALLOWED_FRONTMATTER_PROPERTIES = new Set([
    "name",
    "description",
    "license",
    "allowed-tools",
    "required-secrets",
    "secrets-autonomous",
    "metadata",
    "compatibility",
    "version",
    "author",
]);

const _FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface SkillMarkdownParts {
    metadata: Record<string, unknown>;
    frontmatter_text: string;
    body: string;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 将 SKILL.md 文档拆分为 frontmatter 和 body。
 *
 * @returns [parts, null] 成功，[null, errorMessage] 失败
 */
export function splitSkillMarkdown(content: string): [SkillMarkdownParts | null, string | null] {
    const match = _FRONTMATTER_RE.exec(content);
    if (!match) return [null, "No YAML frontmatter found"];

    const frontmatterText = match[1];
    let metadata: unknown;
    try {
        metadata = parseYaml(frontmatterText);
    } catch (error) {
        return [null, `Invalid YAML in frontmatter: ${error}`];
    }

    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        return [null, "Frontmatter must be a YAML dictionary"];
    }

    return [
        {
            metadata: metadata as Record<string, unknown>,
            frontmatter_text: frontmatterText,
            body: content.slice(match.index + match[0].length),
        },
        null,
    ];
}
