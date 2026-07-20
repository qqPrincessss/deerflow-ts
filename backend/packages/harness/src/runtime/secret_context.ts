/**
 * 密钥上下文 — 管理请求级密钥（如用户的 API token）。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/secret_context.py
 *
 * 解决什么问题？
 * 用户的 API key 不能出现在对话消息、工具参数、命令字符串里。
 * 这个模块通过运行时上下文传递密钥，只在执行技能脚本时注入为环境变量。
 */

/** 运行时上下文中存储密钥的 key（调用方传入的） */
export const SECRETS_CONTEXT_KEY = "secrets";

/** 当前激活技能的密钥 key（中间件设置的） */
export const ACTIVE_SECRETS_CONTEXT_KEY = "__active_skill_secrets";

/** 斜杠命令密钥来源 key */
const SLASH_SECRET_SOURCE_KEY = "__slash_skill_secret_source";

/** 密钥绑定审计 key */
const SECRETS_BINDING_AUDIT_KEY = "__skill_secrets_binding_audit";

/** 斜杠命令激活运行 key */
const SLASH_SKILL_ACTIVATION_RUN_KEY = "__slash_skill_activation_run";

//  作用：从运行时上下文中提取密钥。只保留 string key 和 string value，其他的忽略。
export function extractRequestSecrets(context: unknown): Record<string, string> {
    if (!context || typeof context !== "object") return {};
    const raw = (context as Record<string, unknown>)[SECRETS_CONTEXT_KEY];
    if (!raw || typeof raw !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key === "string" && typeof value === "string") {
            result[key] = value;
        }
    }
    return result;
}

//  作用：读取当前激活技能的密钥。bash 工具用这个来构建环境变量。
export function readActiveSecrets(context: unknown): Record<string, string> {
    if (!context || typeof context !== "object") return {};
    const raw = (context as Record<string, unknown>)[ACTIVE_SECRETS_CONTEXT_KEY];
    if (!raw || typeof raw !== "object") return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key === "string" && typeof value === "string") {
            result[key] = value;
        }
    }
    return result;
}

/** 需要脱敏的 key 集合 */
export const REDACTED_CONTEXT_KEYS = new Set([
    SECRETS_CONTEXT_KEY,
    ACTIVE_SECRETS_CONTEXT_KEY,
    SLASH_SECRET_SOURCE_KEY,
    SECRETS_BINDING_AUDIT_KEY,
    SLASH_SKILL_ACTIVATION_RUN_KEY,
]);

export function redactSecretContextKeys(context: unknown): unknown {
    if (!context || typeof context !== "object") return context;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
        if (!REDACTED_CONTEXT_KEYS.has(key)) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * 去掉配置中的密钥（防止存到数据库或返回给前端）。
 *
 * 对应原项目 redact_config_secrets。
 */
export function redactConfigSecrets(config: unknown): unknown {
    if (!config || typeof config !== "object") return config;
    const configObj = config as Record<string, unknown>;
    const context = configObj.context;
    if (!context || typeof context !== "object") return config;
    return {
        ...configObj,
        context: redactSecretContextKeys(context),
    };
}