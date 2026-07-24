/**
 * Lead Agent 工厂 — 构建 Lead Agent 的完整中间件链和 Agent 实例。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/lead_agent/agent.py
 *
 * INVARIANT — tracing callback placement
 * ======================================
 * Tracing callbacks 在 graph invocation root 处附加（makeLeadAgent 中）。
 * 所有在此模块内或从此模块 reachable 的中间件中的 createChatModel 调用
 * 必须传递 attachTracing=false，否则会产生重复 span。
 */

import { type BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AppConfig } from "../../config/app_config.js";
import { getAppConfig, getModelConfig } from "../../config/app_config.js";
import { applyPromptTemplate } from "./prompt.js";
import {
    DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN,
    clampSubagentConcurrency,
    clampTotalSubagentsPerRun,
} from "../../config/subagents_config.js";
import { createChatModel } from "../../models/factory.js";
import { type Skill } from "../../skills/types.js";
import { filterToolsBySkillAllowedTools, ALWAYS_AVAILABLE_BUILTIN_TOOL_NAMES } from "../../skills/tool_policy.js";
import { createDeerFlowAgent, type RuntimeContext, type RuntimeFeatures, type Message } from "../factory.js";
import type { DeferredToolSetup } from "../../tools/builtins/tool_search.js";
import { buildMcpRoutingMiddleware, getMcpRoutingHintsPromptSection, assembleDeferredTools } from "../../tools/builtins/tool_search.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _BOOTSTRAP_SKILL_NAMES = new Set(["bootstrap"]);
const _NON_INTERACTIVE_DISABLED_TOOL_NAMES = new Set(["ask_clarification"]);
const _WEBHOOK_CHANNELS = new Set(["github"]);

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

function _defaultMaxTotalSubagents(appConfig: AppConfig): number {
    const subagents = (appConfig as Record<string, unknown>).subagents as Record<string, unknown> | undefined;
    return (subagents?.max_total_per_run as number) ?? DEFAULT_MAX_TOTAL_SUBAGENTS_PER_RUN;
}

function _getRuntimeConfig(config: Record<string, unknown>): Record<string, unknown> {
    const cfg = { ...((config.configurable as Record<string, unknown>) ?? {}) };
    const context = (config.context as Record<string, unknown>) ?? {};
    if (typeof context === "object") {
        Object.assign(cfg, context);
    }
    return cfg;
}

function _resolveModelName(
    requestedModelName?: string | null,
    appConfig?: AppConfig | null,
): string {
    const resolvedConfig = appConfig ?? getAppConfig();
    const defaultModelName = resolvedConfig.models?.[0]?.name;
    if (!defaultModelName) {
        throw new Error("No chat models are configured. Please configure at least one model in config.yaml.");
    }

    if (requestedModelName && getModelConfig(resolvedConfig, requestedModelName)) {
        return requestedModelName;
    }

    if (requestedModelName && requestedModelName !== defaultModelName) {
        console.warn(`Model '${requestedModelName}' not found in config; fallback to default model '${defaultModelName}'.`);
    }
    return defaultModelName;
}

function _availableSkillNames(
    agentConfig?: { skills?: string[] } | null,
    isBootstrap?: boolean,
): Set<string> | null {
    if (isBootstrap) return new Set(_BOOTSTRAP_SKILL_NAMES);
    if (agentConfig?.skills) return new Set(agentConfig.skills);
    return null;
}

function _loadEnabledSkillsForToolPolicy(
    availableSkills: Set<string> | null,
    appConfig: AppConfig,
    userId?: string | null,
): Skill[] {
    try {
        const { getEnabledSkillsForConfig } = require("./prompt.js");
        const skills: Skill[] = getEnabledSkillsForConfig(appConfig, userId ?? undefined);
        if (availableSkills === null) return skills;
        return skills.filter((s) => availableSkills.has(s.name));
    } catch {
        return [];
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// buildMiddlewares
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 构建 Lead Agent 的中间件链。
 * 对应 Python build_middlewares。
 *
 * 返回的配置对象用于 createDeerFlowAgent 的 features 参数。
 */
export function buildMiddlewares(options?: {
    config?: Record<string, unknown>;
    modelName?: string | null;
    agentName?: string | null;
    availableSkills?: Set<string> | null;
    appConfig?: AppConfig | null;
    /** McpRoutingMiddleware 实例（由 tool_search 构建时创建）。 */
    mcpRoutingMiddleware?: Record<string, unknown> | null;
    /** 延迟工具设置。 */
    deferredSetup?: DeferredToolSetup | null;
    userId?: string | null;
}): RuntimeFeatures {
    const resolvedConfig = options?.appConfig ?? getAppConfig();

    const features: RuntimeFeatures = {
        sandbox: true,
        guardrail: true,
        subagent: false,
    };

    // summarization
    const summarizationConfig = (resolvedConfig as Record<string, unknown>).summarization as Record<string, unknown> | undefined;
    if (summarizationConfig?.enabled !== false) {
        features.summarization = true;
    }

    // memory
    const memoryConfig = (resolvedConfig as Record<string, unknown>).memory as Record<string, unknown> | undefined;
    if (memoryConfig?.enabled !== false && memoryConfig?.mode !== "tool") {
        features.memory = true;
    }

    // title
    features.auto_title = true;

    // vision — 如果当前模型支持
    const modelName = options?.modelName;
    if (modelName) {
        const modelConfig = getModelConfig(resolvedConfig, modelName);
        if (modelConfig?.supports_vision) {
            features.vision = true;
        }
    }

    // loop_detection
    const loopDetectionConfig = (resolvedConfig as Record<string, unknown>).loop_detection as Record<string, unknown> | undefined;
    if (loopDetectionConfig?.enabled !== false) {
        features.loop_detection = true;
    }

    // token_budget
    const tokenBudgetConfig = (resolvedConfig as Record<string, unknown>).token_budget as Record<string, unknown> | undefined;
    if (tokenBudgetConfig?.enabled !== false) {
        features.token_budget = true;
    }

    // plan_mode
    if (options?.config) {
        const cfg = _getRuntimeConfig(options.config);
        if (cfg.is_plan_mode) {
            features.plan_mode = true;
        }
    }

    // subagent
    if (options?.config) {
        const cfg = _getRuntimeConfig(options.config);
        if (cfg.subagent_enabled) {
            features.subagent = true;
        }
    }

    return features;
}

// ════════════════════════════════════════════════════════════════════════════════
// makeLeadAgent
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 创建 Lead Agent。
 * 对应 Python make_lead_agent → _make_lead_agent。
 *
 * @param config 运行时配置
 * @returns AgentInstance
 */
export async function makeLeadAgent(
    config: Record<string, unknown>,
): Promise<ReturnType<typeof createDeerFlowAgent>> {
    return _makeLeadAgent(config, getAppConfig());
}

async function _makeLeadAgent(
    config: Record<string, unknown>,
    appConfig: AppConfig,
): Promise<ReturnType<typeof createDeerFlowAgent>> {
    const cfg = _getRuntimeConfig(config);
    const resolvedAppConfig = appConfig;

    // 提取用户标识
    const { getEffectiveUserId } = await import("../../runtime/user_context.js");
    const runtimeUserId = cfg.user_id as string | undefined;
    const resolvedUserId = runtimeUserId ?? getEffectiveUserId();

    // 解析配置项
    const thinkingEnabled = (cfg.thinking_enabled as boolean) ?? true;
    const reasoningEffort = cfg.reasoning_effort as string | undefined;
    const requestedModelName = (cfg.model_name ?? cfg.model) as string | undefined;
    const isPlanMode = (cfg.is_plan_mode as boolean) ?? false;
    const subagentEnabled = (cfg.subagent_enabled as boolean) ?? false;
    const maxConcurrentSubagents = (cfg.max_concurrent_subagents as number) ?? 3;
    const maxTotalSubagents = (cfg.max_total_subagents as number) ?? _defaultMaxTotalSubagents(resolvedAppConfig);
    const isBootstrap = (cfg.is_bootstrap as boolean) ?? false;
    const nonInteractive = (cfg.non_interactive as boolean) ?? false;
    const agentName = cfg.agent_name as string | undefined ?? null;

    // 解析 agent 配置（需 app_config 提供 loadAgentConfig 支持）
    const agentConfig: { model?: string; tool_groups?: string[]; skills?: string[] } | null = null;
    const availableSkills = _availableSkillNames(agentConfig, isBootstrap);
    const agentModelName = null;

    // 最终模型名
    const modelName = _resolveModelName(requestedModelName ?? agentModelName, resolvedAppConfig);

    const modelConfig = getModelConfig(resolvedAppConfig, modelName);
    if (!modelConfig) {
        throw new Error("No chat model could be resolved.");
    }
    if (thinkingEnabled && !modelConfig.supports_thinking) {
        console.warn(`Thinking mode is enabled but model '${modelName}' does not support it; fallback to non-thinking mode.`);
    }
    const effectiveThinking = thinkingEnabled && modelConfig.supports_thinking;

    // 加载技能
    const skillsForToolPolicy = _loadEnabledSkillsForToolPolicy(availableSkills, resolvedAppConfig, resolvedUserId);

    // 构建技能搜索设置
    let skillSearchSetup: { describe_skill_tool?: Record<string, unknown> | null; skill_names?: ReadonlySet<string> | null } = {};
    try {
        const { buildSkillSearchSetup } = await import("../../skills/describe.js");
        const cfg = resolvedAppConfig as Record<string, unknown>;
        const skillsCfg = cfg.skills as Record<string, unknown> | undefined;
        const containerBasePath = skillsCfg?.container_path as string ?? "";
        skillSearchSetup = buildSkillSearchSetup(
            skillsForToolPolicy as any[],
            { enabled: false, containerBasePath },
        );
    } catch {
        skillSearchSetup = {};
    }

    // 获取工具列表
    let rawTools: Array<Record<string, unknown>> = [];
    try {
        const { getAvailableTools } = await import("../../tools/tools.js");
        const toolsResult = await getAvailableTools({ modelName, subagentEnabled, appConfig: resolvedAppConfig });
        rawTools = toolsResult as unknown as Array<Record<string, unknown>>;
    } catch {
        rawTools = [];
    }

    // 添加 setup_agent / update_agent 工具
    const channelName = cfg.channel_name as string | undefined;
    const isWebhookChannel = channelName !== undefined && _WEBHOOK_CHANNELS.has(channelName);
    if (agentName && !isWebhookChannel) {
        try {
            const updateAgentModule = await import("../../tools/builtins/update_agent.js");
            const updateAgentTool = (updateAgentModule as Record<string, unknown>).default ?? Object.values(updateAgentModule)[0];
            if (updateAgentTool) rawTools.push(updateAgentTool as Record<string, unknown>);
        } catch {
            // update_agent tool 不可用
        }
    }

    // 工具策略过滤
    const filteredTools = filterToolsBySkillAllowedTools(
        rawTools as any[],
        skillsForToolPolicy,
        ALWAYS_AVAILABLE_BUILTIN_TOOL_NAMES,
    );
    let nonInteractiveFiltered: any[] = filteredTools;
    if (nonInteractive) {
        nonInteractiveFiltered = filteredTools.filter((t) => !_NON_INTERACTIVE_DISABLED_TOOL_NAMES.has(t.name));
    }

    // 延迟工具装配
    const toolSearchCfg = (resolvedAppConfig as Record<string, unknown>).tool_search as Record<string, unknown> | undefined;
    const toolSearchEnabled = (toolSearchCfg?.enabled as boolean) ?? false;
    const [finalTools, deferredSetup] = assembleDeferredTools(nonInteractiveFiltered as any, toolSearchEnabled);

    const autoPromoteTopK = (toolSearchCfg?.auto_promote_top_k as number) ?? 3;
    const mcpRoutingMiddleware = buildMcpRoutingMiddleware(finalTools as any, deferredSetup, autoPromoteTopK);
    const mcpRoutingHintsSection = getMcpRoutingHintsPromptSection(nonInteractiveFiltered as any, deferredSetup.deferredNames);

    // 添加 describe_skill 工具（如果启用）
    if (skillSearchSetup.describe_skill_tool) {
        finalTools.push(skillSearchSetup.describe_skill_tool as any);
    }

    // 构建中间件配置
    const features = buildMiddlewares({
        config,
        modelName,
        agentName,
        availableSkills,
        appConfig: resolvedAppConfig,
        mcpRoutingMiddleware: mcpRoutingMiddleware as Record<string, unknown> | null,
        deferredSetup,
        userId: resolvedUserId,
    });

    // 构建系统提示词
    const systemPrompt = applyPromptTemplate({
        subagentEnabled,
        maxConcurrentSubagents,
        maxTotalSubagents,
        agentName,
        availableSkills,
        appConfig: resolvedAppConfig,
        deferredNames: deferredSetup.deferredNames,
        mcpRoutingHintsSection,
        userId: resolvedUserId,
        skillNames: skillSearchSetup.skill_names ?? null,
    });

    // 创建模型
    const model = await createChatModel(modelName, effectiveThinking, resolvedAppConfig, false);

    // 创建 Agent
    const context: RuntimeContext = {
        thread_id: cfg.thread_id as string,
        run_id: cfg.run_id as string,
        user_id: resolvedUserId,
        agent_name: agentName ?? undefined,
        subagent_enabled: subagentEnabled,
        max_concurrent_subagents: maxConcurrentSubagents,
        max_total_subagents: maxTotalSubagents,
    };

    return createDeerFlowAgent({
        model: model as unknown as BaseChatModel,
        tools: finalTools as unknown as Array<{
            name: string;
            invoke: (args: Record<string, unknown>) => Promise<unknown> | unknown;
            description?: string;
        }>,
        systemPrompt,
        features,
        context,
        name: agentName ?? "lead-agent",
    });
}
