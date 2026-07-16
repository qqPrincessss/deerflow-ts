import { z } from "zod";
import { ModelConfigSchema, resolveConfigValue, type ModelConfig } from "./model-config.js";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import dotenv from "dotenv";

dotenv.config();

// 记忆配置
const MemoryConfigSchema = z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(["middleware", "tool"]).default("middleware"),
});

// 沙箱配置
const SandboxConfigSchema = z.object({
    provider: z.enum(["local", "aio", "e2b"]).default("local"),
    allow_host_bash: z.boolean().default(true),
});

// 子代理配置
const SubagentsConfigSchema = z.object({
    enabled: z.boolean().default(true),
    max_concurrent: z.number().default(3),
});

// 主配置
export const AppConfigSchema = z.object({
    config_version: z.number().default(1),
    models: z.array(ModelConfigSchema).default([]),
    memory: MemoryConfigSchema.default({}),
    sandbox: SandboxConfigSchema.default({}),
    subagents: SubagentsConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// 缓存
let _cache: { config: AppConfig; path: string; signature: string } | null = null;

function findConfigPath(): string | null {
    const envPath = process.env.DEER_FLOW_CONFIG_PATH;
    if (envPath) return envPath;
    const cwd = process.cwd();
    for (const dir of [cwd, resolve(cwd, ".."), resolve(cwd, "../..")]) {
        try { statSync(resolve(dir, "config.yaml")); return resolve(dir, "config.yaml"); }
        catch { /* not found */ }
    }
    return null;
}

function computeSignature(filePath: string): string {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    const hash = createHash("sha256").update(`${stat.mtimeMs}:${stat.size}:${content}`).digest("hex").slice(0, 16);
    return `${stat.mtimeMs}:${stat.size}:${hash}`;
}

function resolveEnvVars(obj: unknown): unknown {
    if (typeof obj === "string") return resolveConfigValue(obj);
    if (Array.isArray(obj)) return obj.map(resolveEnvVars);
    if (obj && typeof obj === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) result[k] = resolveEnvVars(v);
        return result;
    }
    return obj;
}

export function getAppConfig(configPath?: string): AppConfig {
    const path = configPath || findConfigPath();
    if (!path) { console.warn("No config.yaml found, using defaults"); return AppConfigSchema.parse({}); }
    const signature = computeSignature(path);
    if (_cache && _cache.path === path && _cache.signature === signature) return _cache.config;
    const raw = YAML.parse(readFileSync(path, "utf-8"));
    const resolved = resolveEnvVars(raw);
    const config = AppConfigSchema.parse(resolved);
    _cache = { config, path, signature };
    return config;
}

export function getModelConfig(appConfig: AppConfig, name: string): ModelConfig | undefined {
    return appConfig.models.find((m) => m.name === name);
}

export function getDefaultModelConfig(appConfig: AppConfig): ModelConfig {
    if (appConfig.models.length === 0) throw new Error("No models configured");
    return appConfig.models[0];
}
