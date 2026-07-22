/**
 * 创建自定义 Agent — 写入 SOUL.md 和 config.yaml。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/builtins/setup_agent_tool.py
 *
 * 自定义 Agent 存储在 {baseDir}/users/{userId}/agents/{name}/ 下。
 * 如果 agent_name 为 null，则 SOUL.md 写入 baseDir（默认 Agent）。
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAppConfig } from "../../config/app_config.js";
import { VIRTUAL_PATH_PREFIX } from "../../config/paths.js";
import { resolveRuntimeUserId } from "../../runtime/user_context.js";
import { type Runtime } from "../types.js";

const _AGENT_NAME_RE = /^[A-Za-z0-9-]+$/;
const SOUL_FILENAME = "SOUL.md";
const CONFIG_FILENAME = "config.yaml";

function _getBaseDir(): string {
    try {
        const config = getAppConfig() as Record<string, unknown>;
        const paths = config.paths as Record<string, unknown> | undefined;
        return (paths?.baseDir as string) ?? ".deer-flow";
    } catch {
        return ".deer-flow";
    }
}

function _userAgentDir(userId: string, agentName: string): string {
    return `${_getBaseDir()}/users/${userId}/agents/${agentName}`;
}

/**
 * 校验自定义 Agent 名称。
 * 只允许字母、数字、连字符。
 */
export function validateAgentName(name: string | null | undefined): string | null {
    if (name == null) return null;
    if (typeof name !== "string") {
        throw new Error("Invalid agent name. Expected a string or None.");
    }
    if (!_AGENT_NAME_RE.test(name)) {
        throw new Error(
            `Invalid agent name '${name}'. Must match pattern: ${_AGENT_NAME_RE.source}`,
        );
    }
    return name;
}

/**
 * 创建自定义 DeerFlow Agent。
 *
 * Args:
 *   soul: 完整的 SOUL.md 内容，定义 Agent 个性和行为。
 *   description: Agent 的一行描述。
 *   skills: 可选技能列表。None = 使用所有已启用技能，[] = 无技能。
 *
 * @returns 操作结果字符串
 */
export function setupAgent(
    soul: string,
    description: string,
    runtime: Runtime,
    skills?: string[] | null,
): string {
    // 检查空 soul
    if (!soul || !soul.trim()) {
        return "Error: soul content is empty; refusing to create agent with an empty SOUL.md";
    }

    let agentName: string | null = null;
    if (runtime.context?.agent_name && typeof runtime.context.agent_name === "string") {
        agentName = runtime.context.agent_name;
    }

    let agentDir: string | null = null;
    let isNewDir = false;

    try {
        agentName = validateAgentName(agentName);

        if (agentName) {
            const userId = resolveRuntimeUserId(runtime as unknown as Record<string, unknown>);
            agentDir = _userAgentDir(userId, agentName);
        } else {
            // 默认 Agent：SOUL.md 在 baseDir
            agentDir = _getBaseDir();
        }

        isNewDir = agentDir !== null && !existsSync(agentDir);
        mkdirSync(agentDir, { recursive: true });

        if (agentName) {
            // 写 config.yaml
            const configData: Record<string, unknown> = { name: agentName };
            if (description) configData.description = description;
            if (skills !== undefined && skills !== null) {
                configData.skills = skills;
            }

            const configFile = join(agentDir, CONFIG_FILENAME);
            // YAML 是 JSON 的超集，用 JSON 格式兼容
            const yamlContent = _toYaml(configData);
            writeFileSync(configFile, yamlContent, "utf-8");
        }

        // 写 SOUL.md
        const soulFile = join(agentDir!, SOUL_FILENAME);
        writeFileSync(soulFile, soul.trim(), "utf-8");

        return `Agent '${agentName}' created successfully!`;
    } catch (error) {
        // 失败时清理新建的目录
        if (agentName && isNewDir && agentDir && existsSync(agentDir)) {
            rmSync(agentDir, { recursive: true, force: true });
        }
        return `Error: ${(error as Error).message}`;
    }
}

/**
 * 将配置对象转为 YAML 格式（JSON 子集，兼容 YAML 解析器）。
 */
function _toYaml(data: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;
        lines.push(`${key}:`);
        if (Array.isArray(value)) {
            for (const item of value) {
                lines.push(`  - ${JSON.stringify(item)}`);
            }
        } else if (typeof value === "string") {
            lines.push(`  ${JSON.stringify(value)}`);
        } else {
            lines.push(`  ${String(value)}`);
        }
    }
    return lines.join("\n") + "\n";
}
