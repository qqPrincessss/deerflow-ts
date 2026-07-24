/**
 * 主配置系统。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/app_config.py
 *
 * 聚合所有子配置，提供加载、缓存、环境变量解析。
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { z } from "zod";
import YAML from "yaml";
import dotenv from "dotenv";

import { ModelConfigSchema, resolveConfigValue, type ModelConfig } from "./model-config.js";
import { MemoryConfigSchema } from "./memory_config.js";
import { SandboxConfigSchema } from "./sandbox_config.js";
import { SubagentsAppConfigSchema } from "./subagents_config.js";
import { SummarizationConfigSchema } from "./summarization_config.js";
import { LoopDetectionConfigSchema } from "./loop_detection_config.js";
import { TokenBudgetConfigSchema } from "./token_budget_config.js";
import { TitleConfigSchema } from "./title_config.js";
import { ToolOutputConfigSchema } from "./tool_output_config.js";
import { ToolProgressConfigSchema } from "./tool_progress_config.js";
import { ReadBeforeWriteConfigSchema } from "./read_before_write_config.js";
import { SafetyFinishReasonConfigSchema } from "./safety_finish_reason_config.js";
import { SuggestionsConfigSchema } from "./suggestions_config.js";
import { SkillsConfigSchema } from "./skills_config.js";
import { ToolSearchConfigSchema } from "./tool_search_config.js";
import { ExtensionsConfigSchema } from "./extensions_config.js";

// 加载 .env — 先找当前目录，再找 harness 包目录（backend/packages/harness/.env）
dotenv.config();
const _thisFile = fileURLToPath(import.meta.url);
const _harnessRoot = resolve(dirname(_thisFile), "../../");
dotenv.config({ path: resolve(_harnessRoot, ".env") });

// ─── 主 AppConfig schema ──────────────────────────────────────────────────

export const AppConfigSchema = z.object({
    /** 配置版本号 */
    config_version: z.number().default(1),

    /** 日志级别 */
    log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),

    /** 模型列表 */
    models: z.array(ModelConfigSchema).default([]),

    /** 沙箱配置 */
    sandbox: SandboxConfigSchema.default({}),

    /** 记忆配置 */
    memory: MemoryConfigSchema.default({}),

    /** 子代理配置 */
    subagents: SubagentsAppConfigSchema.default({}),

    /** 压缩配置 */
    summarization: SummarizationConfigSchema.default({}),

    /** 循环检测配置 */
    loop_detection: LoopDetectionConfigSchema.default({}),

    /** Token 预算配置 */
    token_budget: TokenBudgetConfigSchema.default({}),

    /** 标题配置 */
    title: TitleConfigSchema.default({}),

    /** 工具输出配置 */
    tool_output: ToolOutputConfigSchema.default({}),

    /** 工具进度配置 */
    tool_progress: ToolProgressConfigSchema.default({}),

    /** 写前读配置 */
    read_before_write: ReadBeforeWriteConfigSchema.default({}),

    /** 安全终止配置 */
    safety_finish_reason: SafetyFinishReasonConfigSchema.default({}),

    /** 建议配置 */
    suggestions: SuggestionsConfigSchema.default({}),

    /** 技能配置 */
    skills: SkillsConfigSchema.default({}),

    /** 工具搜索配置 */
    tool_search: ToolSearchConfigSchema.default({}),

    /** 扩展配置 */
    extensions: ExtensionsConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── 配置加载 ──────────────────────────────────────────────────

/** 缓存 */
let _cache: { config: AppConfig; path: string; signature: string } | null = null;

/**
 * 找 config.yaml 的位置。
 *
 * 优先级：
 * 1. DEER_FLOW_CONFIG_PATH 环境变量
 * 2. 当前目录的 config.yaml
 * 3. 上级目录的 config.yaml（项目根目录）
 */
function findConfigPath(): string | null {
    const envPath = process.env.DEER_FLOW_CONFIG_PATH;
    if (envPath) return envPath;

    const cwd = process.cwd();
    for (const dir of [cwd, resolve(cwd, "..")]) {
        try {
            statSync(resolve(dir, "config.yaml"));
            return resolve(dir, "config.yaml");
        } catch { /* not found */ }
    }
    return null;
}

/**
 * 计算文件签名（mtime + size + sha256），用于缓存失效。
 */
function computeSignature(filePath: string): string {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    const hash = createHash("sha256")
        .update(`${stat.mtimeMs}:${stat.size}:${content}`)
        .digest("hex")
        .slice(0, 16);
    return `${stat.mtimeMs}:${stat.size}:${hash}`;
}

/**
 * 递归解析 $ENV_VAR 引用。
 */
function resolveEnvVars(obj: unknown): unknown {
    if (typeof obj === "string") {
        return resolveConfigValue(obj);
    }
    if (Array.isArray(obj)) {
        return obj.map(resolveEnvVars);
    }
    if (obj && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
            result[k] = resolveEnvVars(v);
        }
        return result;
    }
    return obj;
}

/**
 * 加载配置。有缓存，文件没变就直接返回缓存。
 *
 * 对应原项目：config/app_config.py 的 get_app_config()
 */
export function getAppConfig(configPath?: string): AppConfig {
    const path = configPath || findConfigPath();

    if (!path) {
        console.warn("No config.yaml found, using defaults");
        return AppConfigSchema.parse({});
    }

    // 检查缓存
    const signature = computeSignature(path);
    if (_cache && _cache.path === path && _cache.signature === signature) {
        return _cache.config;
    }

    // 解析 YAML
    const raw = YAML.parse(readFileSync(path, "utf-8"));

    // 解析环境变量
    const resolved = resolveEnvVars(raw);

    // 校验
    const config = AppConfigSchema.parse(resolved);

    // 存缓存
    _cache = { config, path, signature };

    return config;
}

/**
 * 按名字找模型配置。
 */
export function getModelConfig(appConfig: AppConfig, name: string): ModelConfig | undefined {
    return appConfig.models.find((m) => m.name === name);
}

/**
 * 获取默认（第一个）模型配置。
 */
export function getDefaultModelConfig(appConfig: AppConfig): ModelConfig {
    if (appConfig.models.length === 0) {
        throw new Error("No models configured");
    }
    return appConfig.models[0];
}

/**
 * 清除缓存（强制下次重新加载）。
 */
export function invalidateConfigCache(): void {
    _cache = null;
}
