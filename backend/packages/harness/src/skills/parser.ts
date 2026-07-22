/**
 * 技能解析器 — 从 SKILL.md 解析技能元数据。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/parser.py
 */
// parser.ts 把这段 YAML 解析出来，转化成系统能用的 Skill 对象。

//   输入：SKILL.md 文件路径
//             ↓
//   parser.ts     ←  在这
//             ↓
//   输出：{ name: "code-review", description: "帮我审查代码", allowed_tools: ["read_file"], ... }
import { readFileSync, existsSync } from "node:fs";
import { dirname, basename, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Skill, type SecretRequirement, SkillCategory, SKILL_MD_FILE } from "./types.js";

/** 有效的 POSIX 环境变量名正则 */
const _ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 allowed-tools frontmatter 字段。
 * 省略时返回 null，显式空列表时返回 []。
 */
function _parseAllowedTools(raw: unknown, skillFile: string): string[] | null {
    if (raw === null || raw === undefined) return null;
    if (!Array.isArray(raw)) {
        throw new Error(`allowed-tools in ${skillFile} must be a list of strings`);
    }

    const tools: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") {
            throw new Error(`allowed-tools in ${skillFile} must contain only strings`);
        }
        const name = item.trim();
        if (!name) {
            throw new Error(`allowed-tools in ${skillFile} cannot contain empty tool names`);
        }
        tools.push(name);
    }
    return tools;
}

/**
 * 解析 required-secrets frontmatter 字段。
 */
function _parseRequiredSecrets(raw: unknown, skillFile: string): SecretRequirement[] {
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw)) {
        throw new Error(`required-secrets in ${skillFile} must be a list`);
    }

    const secrets: SecretRequirement[] = [];
    const seen = new Set<string>();

    for (const item of raw) {
        let name = "";
        let optional = false;

        if (typeof item === "string") {
            name = item.trim();
        } else if (typeof item === "object" && item !== null) {
            const obj = item as Record<string, unknown>;
            name = String(obj.name ?? "").trim();
            optional = Boolean(obj.optional);
        } else {
            continue;
        }

        if (!_ENV_VAR_NAME_RE.test(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        secrets.push({ name, optional });
    }

    return secrets;
}

/**
 * 解析 secrets-autonomous frontmatter 字段。
 * 省略时默认 true。非布尔值 fail-closed 到 false。
 */
function _parseSecretsAutonomous(raw: unknown, _skillFile: string): boolean {
    if (raw === null || raw === undefined) return true;
    if (typeof raw === "boolean") return raw;
    return false;
}

/**
 * 定位文件行号（用于错误提示）。
 */
function _findLineNumber(content: string, key: string): number {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`${key}:`)) return i + 1;
    }
    return -1;
}

/**
 * 格式化 YAML 错误。
 */
function _formatYamlError(skillFile: string, error: unknown, _source: string): string {
    return `Invalid YAML front-matter in ${skillFile}: ${error}`;
}

/**
 * 从 SKILL.md 文件解析技能。
 *
 * 读取文件的 YAML frontmatter（--- ... ---），提取：
 * - name（必填）
 * - description（必填）
 * - license（可选）
 * - allowed-tools（可选）
 * - required-secrets（可选）
 * - secrets-autonomous（可选）
 */
export function parseSkillFile(
    filePath: string,
    category: SkillCategory,
    relativePath?: string,
): Skill | null {
    if (!existsSync(filePath)) return null;
    const fileName = basename(filePath);
    if (fileName !== SKILL_MD_FILE) return null;

    let content: string;
    try {
        content = readFileSync(filePath, "utf-8");
    } catch {
        return null;
    }

    // 匹配 YAML frontmatter
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!fmMatch) return null;

    const frontmatterText = fmMatch[1];

    let metadata: Record<string, unknown>;
    try {
        const parsed = parseYaml(frontmatterText);
        if (typeof parsed !== "object" || parsed === null) {
            return null;
        }
        metadata = parsed as Record<string, unknown>;
    } catch (error) {
        console.error(_formatYamlError(filePath, error, frontmatterText));
        return null;
    }

    // 必填字段
    const name = metadata.name;
    if (typeof name !== "string" || !name.trim()) return null;

    const description = metadata.description;
    if (typeof description !== "string" || !description.trim()) return null;

    const trimmedName = name.trim();
    const trimmedDesc = description.trim();

    // 可选字段
    const licenseRaw = metadata.license;
    const license = typeof licenseRaw === "string" && licenseRaw.trim() ? licenseRaw.trim() : null;

    // allowed-tools
    let allowedTools: string[] | null = null;
    try {
        allowedTools = _parseAllowedTools(metadata["allowed-tools"], filePath);
    } catch (error) {
        console.error(`Invalid allowed-tools in ${filePath}: ${error}`);
        return null;
    }

    // required-secrets
    let requiredSecrets: SecretRequirement[] = [];
    try {
        requiredSecrets = _parseRequiredSecrets(metadata["required-secrets"], filePath);
    } catch (error) {
        console.error(`Invalid required-secrets in ${filePath}: ${error}`);
        return null;
    }

    // secrets-autonomous
    const secretsAutonomous = _parseSecretsAutonomous(metadata["secrets-autonomous"], filePath);

    const skillDir = dirname(filePath);
    const relPath = relativePath ?? basename(skillDir);

    return {
        name: trimmedName,
        description: trimmedDesc,
        license,
        skill_dir: skillDir,
        skill_file: filePath,
        relative_path: relPath,
        category,
        allowed_tools: allowedTools,
        enabled: true,
        required_secrets: requiredSecrets,
        secrets_autonomous: secretsAutonomous,
    };
}
