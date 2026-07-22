/**
 * 子代理注册表 — 管理可用的子代理配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/registry.py
 *
 * 数据轮转：
 *   内置模板 + config.yaml 自定义配置 → 注册表 → 执行器
 *   注册表负责：查找、合并覆盖、过滤
 */

import { type SubagentConfig } from "./config.js";
import { type SubagentsAppConfig } from "../config/subagents_config.js";
import { getAppConfig } from "../config/app_config.js";
import { isHostBashAllowed } from "../sandbox/security.js";

// ════════════════════════════════════════════════════════════════════════════════
// 内置子代理配置
// ════════════════════════════════════════════════════════════════════════════════

/** 通用型子代理 — 适合复杂多步骤任务 */
const GENERAL_PURPOSE_CONFIG: SubagentConfig = {
    name: "general-purpose",
    description: `A capable agent for complex, multi-step tasks that require both exploration and action.

Use this subagent when:
- The task requires both exploration and modification
- Complex reasoning is needed to interpret results
- Multiple dependent steps must be executed
- The task would benefit from isolated context management

Do NOT use for simple, single-step operations.`,
    system_prompt: `You are a general-purpose subagent working on a delegated task. Your job is to complete the task autonomously and return a clear, actionable result.

<guidelines>
- Focus on completing the delegated task efficiently
- Use available tools as needed to accomplish the goal
- Think step by step but act decisively
- If you encounter issues, explain them clearly in your response
- Return a concise summary of what you accomplished
- Do NOT ask for clarification - work with the information provided
</guidelines>

<tool_restrictions>
You are a subagent - the \`task\` tool is NOT available to you.
You must NEVER attempt to call \`task\` or dispatch further subagents.
Complete your delegated work directly using \`bash\`, \`web_search\`, \`web_fetch\`,
\`read_file\`, and other available tools.
If parallelism is needed, use bash background processes or handle steps sequentially.
</tool_restrictions>

<file_editing_workflow>
When revising an existing file, prefer \`str_replace\` over \`write_file\` - it sends only the diff and avoids re-emitting the whole file. When writing long new content from scratch, split it into sections: the first \`write_file\` call creates the file, then use \`write_file\` with append=True to extend it section by section.
</file_editing_workflow>

<output_format>
When you complete the task, provide:
1. A brief summary of what was accomplished
2. Key findings or results
3. Any relevant file paths, data, or artifacts created
4. Issues encountered (if any)
5. Citations: Use [citation:Title](URL) format for external sources
</output_format>`,
    tools: null, // 继承父 Agent 的全部工具
    disallowed_tools: ["task", "ask_clarification", "present_files"],
    skills: null,
    model: "inherit",
    max_turns: 150,
    timeout_seconds: 900,
};

/** bash 子代理 — 专用命令执行 */
const BASH_AGENT_CONFIG: SubagentConfig = {
    name: "bash",
    description: `Command execution specialist for running bash commands in a separate context.

Use this subagent when:
- You need to run a series of related bash commands
- Terminal operations like git, npm, docker, etc.
- Command output is verbose and would clutter main context
- Build, test, or deployment operations

Do NOT use for simple single commands - use bash tool directly instead.`,
    system_prompt: `You are a bash command execution specialist. Execute the requested commands carefully and report results clearly.

<guidelines>
- Execute commands one at a time when they depend on each other
- Use parallel execution when commands are independent
- Report both stdout and stderr when relevant
- Handle errors gracefully and explain what went wrong
- Use workspace-relative paths for files under the default workspace, uploads, and outputs directories
- Use absolute paths only when the task references deployment-configured custom mounts outside the default workspace layout
- Be cautious with destructive operations (rm, overwrite, etc.)
</guidelines>

<output_format>
For each command or group of commands:
1. What was executed
2. The result (success/failure)
3. Relevant output (summarized if verbose)
4. Any errors or warnings
</output_format>`,
    tools: ["bash", "ls", "read_file", "write_file", "str_replace"],
    disallowed_tools: ["task", "ask_clarification", "present_files"],
    skills: null,
    model: "inherit",
    max_turns: 60,
    timeout_seconds: 900,
};

/** 内置子代理注册表 */
const BUILTIN_SUBAGENTS: Record<string, SubagentConfig> = {
    "general-purpose": GENERAL_PURPOSE_CONFIG,
    "bash": BASH_AGENT_CONFIG,
};

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从 AppConfig 中提取 SubagentsAppConfig。
 */
function _resolveSubagentsAppConfig(appConfig?: unknown): SubagentsAppConfig {
    if (appConfig === undefined || appConfig === null) {
        const cfg = getAppConfig() as Record<string, unknown>;
        return (cfg.subagents as SubagentsAppConfig) ?? {} as SubagentsAppConfig;
    }
    const subagents = (appConfig as Record<string, unknown>).subagents;
    return (subagents as SubagentsAppConfig) ?? (appConfig as SubagentsAppConfig);
}

/**
 * 从 config.yaml 的 custom_agents 节构建 SubagentConfig。
 */
function _buildCustomSubagentConfig(name: string, appConfig?: unknown): SubagentConfig | null {
    const subagentsConfig = _resolveSubagentsAppConfig(appConfig);
    const custom = subagentsConfig.custom_agents?.[name];
    if (!custom) return null;

    return {
        name,
        description: custom.description,
        system_prompt: custom.system_prompt,
        tools: custom.tools ?? null,
        disallowed_tools: custom.disallowed_tools ?? null,
        skills: custom.skills ?? null,
        model: custom.model ?? "inherit",
        max_turns: custom.max_turns ?? 50,
        timeout_seconds: custom.timeout_seconds ?? 900,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 公开 API
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 根据名称获取子代理配置，应用 config.yaml 覆盖。
 *
 * 解析顺序（3 层）：
 * 1. 内置子代理（general-purpose, bash）
 * 2. 自定义子代理（config.yaml custom_agents 节）
 * 3. Per-agent 覆盖（config.yaml agents 节：timeout, max_turns, model, skills）
 *
 * 覆盖规则：
 * - timeout / max_turns：per-agent 覆盖 > 全局默认（仅内置） > 自身值
 * - model / skills：仅 per-agent 覆盖（没有全局默认）
 *
 * @param name 子代理名称
 * @param appConfig 可选的 AppConfig（测试注入用）
 * @returns SubagentConfig 或 null（未找到）
 */
export function getSubagentConfig(name: string, appConfig?: unknown): SubagentConfig | null {
    // Step 1: 查找内置，然后退到自定义
    const builtin = BUILTIN_SUBAGENTS[name];
    let config: SubagentConfig = builtin ?? _buildCustomSubagentConfig(name, appConfig) as SubagentConfig;
    if (!config) return null;

    // Step 2: 应用 per-agent 覆盖
    const subagentsConfig = _resolveSubagentsAppConfig(appConfig);
    const isBuiltin = name in BUILTIN_SUBAGENTS;
    const agentOverride = subagentsConfig.agents?.[name];

    const overrides: Partial<SubagentConfig> = {};

    // Timeout: per-agent > 全局默认（仅内置） > 自身
    if (agentOverride?.timeout_seconds !== undefined && agentOverride.timeout_seconds !== null) {
        if (agentOverride.timeout_seconds !== config.timeout_seconds) {
            overrides.timeout_seconds = agentOverride.timeout_seconds;
        }
    } else if (isBuiltin && subagentsConfig.timeout_seconds !== config.timeout_seconds) {
        overrides.timeout_seconds = subagentsConfig.timeout_seconds;
    }

    // Max turns: per-agent > 全局默认（仅内置） > 自身
    if (agentOverride?.max_turns !== undefined && agentOverride.max_turns !== null) {
        if (agentOverride.max_turns !== config.max_turns) {
            overrides.max_turns = agentOverride.max_turns;
        }
    } else if (isBuiltin && subagentsConfig.max_turns !== null && subagentsConfig.max_turns !== undefined && subagentsConfig.max_turns !== config.max_turns) {
        overrides.max_turns = subagentsConfig.max_turns;
    }

    // Model: per-agent only
    const effectiveModel = _getModelFor(subagentsConfig, name);
    if (effectiveModel !== null && effectiveModel !== config.model) {
        overrides.model = effectiveModel;
    }

    // Skills: per-agent only
    const effectiveSkills = _getSkillsFor(subagentsConfig, name);
    if (effectiveSkills !== null && JSON.stringify(effectiveSkills) !== JSON.stringify(config.skills)) {
        overrides.skills = effectiveSkills;
    }

    if (Object.keys(overrides).length > 0) {
        config = { ...config, ...overrides };
    }

    return config;
}

/**
 * 获取所有可用的子代理名称（内置 + 自定义）。
 */
export function getSubagentNames(appConfig?: unknown): string[] {
    const names = Object.keys(BUILTIN_SUBAGENTS);

    const subagentsConfig = _resolveSubagentsAppConfig(appConfig);
    for (const customName of Object.keys(subagentsConfig.custom_agents ?? {})) {
        if (!names.includes(customName)) {
            names.push(customName);
        }
    }

    return names;
}

/**
 * 列出所有可用的子代理配置（已应用 config.yaml 覆盖）。
 */
export function listSubagents(appConfig?: unknown): SubagentConfig[] {
    const configs: SubagentConfig[] = [];
    for (const name of getSubagentNames(appConfig)) {
        const config = getSubagentConfig(name, appConfig);
        if (config !== null) {
            configs.push(config);
        }
    }
    return configs;
}

/**
 * 获取当前运行环境可见的子代理名称。
 *
 * 当 host bash 被禁用时，过滤掉 bash 子代理。
 */
export function getAvailableSubagentNames(appConfig?: unknown): string[] {
    const names = getSubagentNames(appConfig);

    let hostBashAllowed: boolean;
    try {
        hostBashAllowed = isHostBashAllowed(appConfig as Record<string, unknown> | undefined);
    } catch {
        return names;
    }

    if (!hostBashAllowed) {
        return names.filter((n) => n !== "bash");
    }

    return names;
}

// ════════════════════════════════════════════════════════════════════════════════
// SubagentsAppConfig 辅助方法（原项目是类上的方法，这里作为独立函数）
// ════════════════════════════════════════════════════════════════════════════════

function _getModelFor(subagentsConfig: SubagentsAppConfig, name: string): string | null {
    const agent = subagentsConfig.agents?.[name];
    if (agent?.model && typeof agent.model === "string" && agent.model.trim()) {
        return agent.model;
    }
    return null;
}

function _getSkillsFor(subagentsConfig: SubagentsAppConfig, name: string): string[] | null {
    const agent = subagentsConfig.agents?.[name];
    if (agent?.skills !== undefined && agent.skills !== null) {
        return agent.skills;
    }
    return null;
}
