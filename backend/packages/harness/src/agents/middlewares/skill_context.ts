/**
 * 技能上下文捕获和渲染。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/skill_context.py
 */

import { type SkillEntry } from "../thread_state.js";

/** 技能文件名 */
const SKILL_FILE_NAME = "SKILL.md";

/** frontmatter 正则 */
const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

/** 技能上下文 entry key */
export const SKILL_CONTEXT_ENTRY_KEY = "skill_context_entry";

/** 技能描述最大字符数 */
const SKILL_DESCRIPTION_MAX_CHARS = 500;

/** 技能条目元数据 */
export interface SkillEntryMetadata {
    path: string;
    description: string;
}

/**
 * 从 tool_call 中提取工具名。
 */
function toolCallName(toolCall: Record<string, unknown>): string {
    const name = toolCall.name;
    if (typeof name === "string") return name;
    const func = toolCall.function;
    if (func && typeof func === "object" && typeof (func as Record<string, unknown>).name === "string") {
        return (func as Record<string, unknown>).name as string;
    }
    return "";
}

/**
 * 从 tool_call 中提取 tool_call_id。
 */
function toolCallId(toolCall: Record<string, unknown>): string | null {
    const id = toolCall.id;
    return id ? String(id) : null;
}

/**
 * 从 tool_call 的 args 中提取文件路径。
 */
export function toolCallPath(toolCall: Record<string, unknown>): string | null {
    const args = toolCall.args;
    if (!args || typeof args !== "object") return null;
    const obj = args as Record<string, unknown>;
    for (const key of ["path", "file_path", "filepath"]) {
        const value = obj[key];
        if (typeof value === "string" && value) return value;
    }
    return null;
}

/**
 * 标准化路径（在根目录下）。
 *
 * 对应原项目的 posixpath.normpath：
 * - 处理 .. 和 . 路径段
 * - 合并连续斜杠
 * - 去掉末尾斜杠
 */
function normalizeUnderRoot(path: string, normalizedRoot: string): string | null {
    // 标准化路径：处理 ..、.、连续斜杠
    const parts = path.split("/");
    const normalized: string[] = [];
    for (const part of parts) {
        if (part === "..") {
            normalized.pop();
        } else if (part !== "." && part !== "") {
            normalized.push(part);
        }
    }
    const result = "/" + normalized.join("/");

    if (result === normalizedRoot || result.startsWith(normalizedRoot + "/")) {
        return result;
    }
    return null;
}

/**
 * 判断是否是技能文件。
 */
function isSkillFile(path: string): boolean {
    const parts = path.split("/");
    return parts[parts.length - 1] === SKILL_FILE_NAME;
}

/**
 * 从 SKILL.md 路径推导技能名。
 */
function skillNameFromPath(skillMdPath: string): string {
    const parts = skillMdPath.split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/**
 * 从 SKILL.md 内容中提取 frontmatter description。
 *
 * 对应原项目的 yaml.safe_load 解析：
 * - 提取 YAML frontmatter
 * - 解析 description 字段
 * - 规范化空白字符
 * - 截断到最大长度
 */
function parseDescription(content: string): string {
    const match = FRONT_MATTER_RE.exec(content);
    if (!match) return "";
    try {
        const yamlContent = match[1];
        // 解析 YAML frontmatter（支持多行 description）
        const lines = yamlContent.split("\n");
        let inDescription = false;
        let description = "";

        for (const line of lines) {
            if (line.startsWith("description:")) {
                inDescription = true;
                // 单行 description
                const value = line.slice("description:".length).trim();
                if (value) {
                    description = value;
                    break;
                }
            } else if (inDescription) {
                // 多行 description（缩进的行）
                if (line.startsWith("  ") || line.startsWith("\t")) {
                    description += " " + line.trim();
                } else {
                    break;
                }
            }
        }

        if (!description) return "";

        // 规范化空白字符并截断
        return description.split(/\s+/).join(" ").slice(0, SKILL_DESCRIPTION_MAX_CHARS);
    } catch {
        return "";
    }
}

/**
 * 判断是否是工具错误文本。
 */
function isToolErrorText(content: string): boolean {
    return content.trimStart().startsWith("Error:");
}

/**
 * 从读取结果构建技能条目元数据。
 */
export function buildSkillEntryMetadataFromRead(
    path: string,
    content: string,
    skillsRoot: string
): SkillEntryMetadata | null {
    const normalizedRoot = skillsRoot.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
    const normalizedPath = normalizeUnderRoot(path, normalizedRoot);

    if (normalizedPath === null || !isSkillFile(normalizedPath) || isToolErrorText(content)) {
        return null;
    }

    return {
        path: normalizedPath,
        description: parseDescription(content),
    };
}

/**
 * 从消息的 additional_kwargs 中读取技能条目元数据。
 */
export function readSkillEntryMetadata(
    additionalKwargs: Record<string, unknown> | null | undefined
): SkillEntryMetadata | null {
    if (!additionalKwargs) return null;

    const raw = additionalKwargs[SKILL_CONTEXT_ENTRY_KEY];
    if (!raw || typeof raw !== "object") return null;

    const obj = raw as Record<string, unknown>;
    const path = obj.path;
    const description = obj.description;

    if (typeof path !== "string") return null;

    return {
        path,
        description: typeof description === "string"
            ? description.split(/\s+/).join(" ").slice(0, SKILL_DESCRIPTION_MAX_CHARS)
            : "",
    };
}

/**
 * 从消息历史中提取已加载的技能。
 */
export function extractSkills(
    messages: Array<Record<string, unknown>>,
    skillsRoot: string,
    readToolNames: string[]
): SkillEntry[] {
    const normalizedRoot = skillsRoot.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
    const readNames = new Set(readToolNames);

    // 第一遍：找到所有读取 SKILL.md 的 tool_call
    const skillPathsById = new Map<string, string>();
    for (const message of messages) {
        if (message.constructor?.name !== "AIMessage") continue;
        const toolCalls = (message.tool_calls as Array<Record<string, unknown>>) || [];
        for (const toolCall of toolCalls) {
            if (!readNames.has(toolCallName(toolCall))) continue;
            const id = toolCallId(toolCall);
            const rawPath = toolCallPath(toolCall);
            const path = rawPath ? normalizeUnderRoot(rawPath, normalizedRoot) : null;
            if (id && path && isSkillFile(path)) {
                skillPathsById.set(id, path);
            }
        }
    }

    // 第二遍：找到对应的 ToolMessage，提取元数据
    const entries: SkillEntry[] = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.constructor?.name !== "ToolMessage") continue;
        if ((message.status as string) === "error") continue;

        const toolCallIdStr = message.tool_call_id ? String(message.tool_call_id) : "";
        const expectedPath = skillPathsById.get(toolCallIdStr);
        if (!expectedPath) continue;

        const metadata = readSkillEntryMetadata(message.additional_kwargs as Record<string, unknown>);
        if (!metadata) continue;
        if (metadata.path !== expectedPath) continue;

        entries.push({
            name: skillNameFromPath(expectedPath),
            path: expectedPath,
            description: metadata.description,
            loaded_at: index,
        });
    }

    return entries;
}

/**
 * 渲染技能上下文为紧凑的提醒文本。
 */
export function renderSkillContext(entries: SkillEntry[]): string {
    if (entries.length === 0) return "";

    const lines = ["## Active skills (loaded earlier - re-read the file before applying its instructions)"];
    for (const entry of entries) {
        const name = escapeHtml(entry.name);
        const path = escapeHtml(entry.path);
        const rawDescription = entry.description || "";
        const description = escapeHtml(
            typeof rawDescription === "string"
                ? rawDescription.split(/\s+/).join(" ").slice(0, SKILL_DESCRIPTION_MAX_CHARS)
                : ""
        );
        const suffix = description ? `: ${description}` : "";
        lines.push(`- ${name}${suffix} -> ${path}`);
    }
    return lines.join("\n");
}

/**
 * 简单的 HTML 转义。
 */
function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
