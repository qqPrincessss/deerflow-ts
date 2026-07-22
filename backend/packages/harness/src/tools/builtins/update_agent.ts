/**
 * 更新自定义 Agent — 持久化更新 SOUL.md 和 config.yaml。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/builtins/update_agent_tool.py
 *
 * 仅当 runtime.context 中有 agent_name（即在自定义 Agent 对话内）时可用。
 * 使用临时文件 staging + 原子重命名，防止部分写入导致数据不一致。
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { getAppConfig } from "../../config/app_config.js";
import { resolveRuntimeUserId } from "../../runtime/user_context.js";
import { type Runtime } from "../types.js";
import { validateAgentName } from "./setup_agent.js";

/** 不可信渠道（webhook），禁止 agent 自修改 */
const _UNTRUSTED_CHANNELS = new Set(["github"]);

/** 被视作 null 的字符串 */
const _NULLISH_STRINGS = new Set(["null", "none", "undefined"]);

const SOUL_FILENAME = "SOUL.md";
const CONFIG_FILENAME = "config.yaml";
const MANAGED_FIELDS = new Set(["name", "description", "model", "tool_groups", "skills"]);

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

function _legacyAgentDir(agentName: string): string {
    return `${_getBaseDir()}/agents/${agentName}`;
}

/**
 * 将内容写入临时文件并返回路径。
 */
function _stageTemp(targetPath: string, text: string): string {
    const dir = dirname(targetPath);
    mkdirSync(dir, { recursive: true });

    const tmpDir = mkdtempSync(join(tmpdir(), "agent-update-"));
    const tmpPath = join(tmpDir, "stage.tmp");

    try {
        writeFileSync(tmpPath, text, "utf-8");
        return tmpPath;
    } catch (error) {
        // 清理 temp 目录
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        try { rmDirSync(tmpDir); } catch { /* ignore */ }
        throw error;
    }
}

function rmDirSync(path: string): void {
    try {
        const { rmSync } = require("node:fs");
        rmSync(path, { recursive: true, force: true });
    } catch { /* ignore */ }
}

/**
 * 清理临时文件。
 */
function _cleanupTemps(tmpPaths: string[]): void {
    for (const tmp of tmpPaths) {
        try {
            const { rmSync } = require("node:fs");
            const dir = dirname(tmp);
            rmSync(tmp, { force: true });
            rmSync(dir, { recursive: true, force: true }); // 清理 temp 子目录
        } catch { /* ignore */ }
    }
}

/**
 * 判断字符串是否是 null-like（"null", "none", "undefined"）。
 */
function _isNullishString(value: unknown): boolean {
    return typeof value === "string" && _NULLISH_STRINGS.has(value.trim().toLowerCase());
}

function _normalizeNullish(value: unknown): unknown {
    return _isNullishString(value) ? null : value;
}

// AgentConfig 接口
interface AgentConfig {
    name: string;
    description?: string;
    model?: string | null;
    tool_groups?: string[] | null;
    skills?: string[] | null;
    [key: string]: unknown;
}

/**
 * 加载现有 Agent 配置。
 */
function _loadAgentConfig(userId: string, agentName: string): AgentConfig | null {
    const agentDir = _userAgentDir(userId, agentName);
    const configFile = join(agentDir, CONFIG_FILENAME);

    if (!existsSync(configFile)) return null;

    try {
        const raw = readFileSync(configFile, "utf-8");
        const parsed = _parseYaml(raw);
        if (parsed && typeof parsed.name === "string") return parsed as AgentConfig;
        return null;
    } catch {
        return null;
    }
}

/**
 * 简单的 YAML/JSON 解析器（兼容 YAML JSON 子集）。
 */
function _parseYaml(text: string): Record<string, unknown> {
    // 先尝试 JSON 解析
    try {
        return JSON.parse(text);
    } catch {
        // fallback: 简单 YAML 解析
        const result: Record<string, unknown> = {};
        let currentKey: string | null = null;
        let currentArray: unknown[] | null = null;

        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;

            // 数组项: "  - value"
            const arrayMatch = trimmed.match(/^-\s+(.*)/);
            if (arrayMatch && currentKey) {
                (result[currentKey] as unknown[]) ??= [];
                (result[currentKey] as unknown[]).push(_parseYamlValue(arrayMatch[1]));
                continue;
            }

            // 键值对: "key: value"
            const kvMatch = trimmed.match(/^([^:]+):\s*(.*)/);
            if (kvMatch) {
                currentKey = kvMatch[1].trim();
                const value = kvMatch[2].trim();
                if (value === "") {
                    // 可能是列表或 map，延迟解析
                    result[currentKey] = [];
                } else {
                    result[currentKey] = _parseYamlValue(value);
                }
            }
        }

        return result;
    }
}

function _parseYamlValue(value: string): unknown {
    if (value === "null" || value === "~") return null;
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    // 去掉引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * 将配置对象转为 YAML 格式。
 */
function _toYaml(data: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            lines.push(`${key}:`);
            for (const item of value) {
                if (item === null) {
                    lines.push("  - null");
                } else if (typeof item === "string") {
                    // 包含特殊字符时加引号
                    if (/[:\{\}\[\],&\*\?\|<>=!%@`#\n]/.test(item) || item === "") {
                        lines.push(`  - ${JSON.stringify(item)}`);
                    } else {
                        lines.push(`  - ${item}`);
                    }
                } else {
                    lines.push(`  - ${String(item)}`);
                }
            }
        } else if (value === null) {
            lines.push(`${key}: null`);
        } else if (typeof value === "string") {
            if (/[:\{\}\[\],&\*\?\|<>=!%@`#\n]/.test(value) || value === "") {
                lines.push(`${key}: ${JSON.stringify(value)}`);
            } else {
                lines.push(`${key}: ${value}`);
            }
        } else {
            lines.push(`${key}: ${String(value)}`);
        }
    }
    return lines.join("\n") + "\n";
}

/**
 * 保留非托管字段（如 github）。
 */
function _preserveNonManagedFields(existingCfg: AgentConfig): Record<string, unknown> {
    const preserved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existingCfg)) {
        if (!MANAGED_FIELDS.has(key) && value !== undefined) {
            preserved[key] = value;
        }
    }
    return preserved;
}

/**
 * 更新当前自定义 Agent 的 SOUL.md 和 config.yaml。
 *
 * 只更新显式传入的字段；省略的字段保留原值。
 * soul 是完整替换（非 patch），始终从当前 SOUL 开始编辑。
 * skills=[] 禁用所有技能，省略 skills 保留现有白名单。
 * 不要传 "null"/"none"/"undefined" 作为未变更字段的值，省略它们即可。
 *
 * @param soul 可选完整替换的 SOUL.md 内容
 * @param description 可选新描述
 * @param skills 可选技能白名单
 * @param toolGroups 可选工具组白名单
 * @param model 可选模型覆盖
 * @returns 操作结果字符串
 */
export function updateAgent(
    runtime: Runtime,
    soul?: string | null,
    description?: string | null,
    skills?: string[] | null,
    toolGroups?: string[] | null,
    model?: string | null,
): string {
    function _err(message: string): string {
        return `Error: ${message}`;
    }

    // 规范化 null-like 字符串
    soul = _normalizeNullish(soul) as string | null | undefined;
    description = _normalizeNullish(description) as string | null | undefined;
    skills = _normalizeNullish(skills) as string[] | null | undefined;
    toolGroups = _normalizeNullish(toolGroups) as string[] | null | undefined;
    model = _normalizeNullish(model) as string | null | undefined;

    const ctx = runtime.context;
    const agentNameRaw: string | undefined = ctx?.agent_name as string | undefined;
    const channelName: string | undefined = ctx?.channel_name as string | undefined;

    // 不可信渠道拦截
    if (channelName && _UNTRUSTED_CHANNELS.has(channelName)) {
        return _err(
            `update_agent is disabled on the '${channelName}' channel. ` +
            "Self-mutation requests must come from an operator-trusted surface (chat UI or the HTTP API), not a webhook fan-out.",
        );
    }

    // 至少需要传一个字段
    if (soul === undefined && description === undefined && skills === undefined && toolGroups === undefined && model === undefined) {
        return _err(
            "No fields provided. Pass at least one of: soul, description, skills, tool_groups, model. " +
            'Omit unchanged fields instead of passing null-like strings such as "null", "none", or "undefined".',
        );
    }

    let agentName: string | null;
    try {
        agentName = validateAgentName(agentNameRaw);
    } catch (error) {
        return _err((error as Error).message);
    }

    if (!agentName) {
        return _err(
            "update_agent is only available inside a custom agent's chat. " +
            "There is no agent_name in the current runtime context, so there is nothing to update. " +
            "If you are inside the bootstrap flow, use setup_agent instead.",
        );
    }

    const userId = resolveRuntimeUserId(runtime as unknown as Record<string, unknown>);
    const agentDir = _userAgentDir(userId, agentName);
    const legacyDir = _legacyAgentDir(agentName);

    // 检查 per-user 目录是否存在（防止在只存在 legacy 配置时意外 fork）
    const configFile = join(agentDir, CONFIG_FILENAME);
    const legacyConfigFile = join(legacyDir, CONFIG_FILENAME);
    if (!existsSync(configFile) && existsSync(legacyConfigFile)) {
        return _err(
            `Agent '${agentName}' only exists in the legacy shared layout and is not scoped to a user. ` +
            "Run scripts/migrate_user_isolation.py to move legacy agents into the per-user layout before updating.",
        );
    }

    // 加载现有配置
    const existingCfg = _loadAgentConfig(userId, agentName);
    if (!existingCfg) {
        return _err(
            `Agent '${agentName}' does not exist for the current user. Use setup_agent to create a new agent first.`,
        );
    }

    // 校验 model
    if (model !== undefined && model !== null) {
        const appConfig = getAppConfig() as Record<string, unknown>;
        const getModelConfig = appConfig.get_model_config as ((name: string) => unknown) | undefined;
        if (!getModelConfig || getModelConfig(model) === undefined) {
            return _err(`Unknown model '${model}'. Pass a model name that exists in config.yaml's models section.`);
        }
    }

    const updatedFields: string[] = [];

    // 构建新的 config_data
    const configData: Record<string, unknown> = { name: agentName };

    const newDescription = description !== undefined ? description : existingCfg.description;
    configData.description = newDescription ?? "";
    if (description !== undefined && description !== existingCfg.description) {
        updatedFields.push("description");
    }

    const newModel = model !== undefined ? model : existingCfg.model;
    if (newModel !== null && newModel !== undefined) {
        configData.model = newModel;
    }
    if (model !== undefined && model !== existingCfg.model) {
        updatedFields.push("model");
    }

    const newToolGroups = toolGroups !== undefined ? toolGroups : existingCfg.tool_groups;
    if (newToolGroups !== null && newToolGroups !== undefined) {
        configData.tool_groups = newToolGroups;
    }
    if (toolGroups !== undefined && toolGroups !== existingCfg.tool_groups) {
        updatedFields.push("tool_groups");
    }

    const newSkills = skills !== undefined ? skills : existingCfg.skills;
    if (newSkills !== null && newSkills !== undefined) {
        configData.skills = newSkills;
    }
    if (skills !== undefined && skills !== existingCfg.skills) {
        updatedFields.push("skills");
    }

    // 保留非托管字段
    const preserved = _preserveNonManagedFields(existingCfg);
    for (const [key, value] of Object.entries(preserved)) {
        if (!(key in configData)) {
            configData[key] = value;
        }
    }

    const configChanged = ["description", "model", "tool_groups", "skills"].some(
        (f) => updatedFields.includes(f),
    );

    // Stage 所有要写的文件到临时路径
    const pending: Array<{ tmp: string; target: string }> = [];
    const stagedTemps: string[] = [];

    try {
        mkdirSync(agentDir, { recursive: true });

        if (configChanged) {
            const yamlText = _toYaml(configData);
            const configTmp = _stageTemp(configFile, yamlText);
            stagedTemps.push(configTmp);
            pending.push({ tmp: configTmp, target: configFile });
        }

        if (soul !== undefined && soul !== null) {
            const soulTarget = join(agentDir, SOUL_FILENAME);
            const soulTmp = _stageTemp(soulTarget, soul);
            stagedTemps.push(soulTmp);
            pending.push({ tmp: soulTmp, target: soulTarget });
            updatedFields.push("soul");
        }

        // Commit 阶段：原子重命名
        const committed: string[] = [];
        try {
            for (const { tmp, target } of pending) {
                renameSync(tmp, target);
                committed.push(target);
            }
        } catch (error) {
            // 清理未提交的 temp
            const uncommittedTemps = pending
                .filter((p) => !committed.includes(p.target))
                .map((p) => p.tmp);
            _cleanupTemps(uncommittedTemps);

            if (committed.length > 0) {
                return _err(
                    `Partial update for agent '${agentName}': ${committed.map((p) => join(p).split("/").pop()).join(", ")} ` +
                    `were updated, but the rest failed (${(error as Error).message}). ` +
                    "Re-run update_agent to retry the remaining fields.",
                );
            }
            throw error;
        }
    } catch (error) {
        _cleanupTemps(stagedTemps);
        return _err(`Failed to update agent '${agentName}': ${(error as Error).message}`);
    }

    if (updatedFields.length === 0) {
        return `No changes applied to agent '${agentName}'. The provided values matched the existing config.`;
    }

    return `Agent '${agentName}' updated successfully. Changed: ${updatedFields.join(", ")}. The new configuration takes effect on the next user turn.`;
}
