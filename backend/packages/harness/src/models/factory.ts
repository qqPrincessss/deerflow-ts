import { AppConfig, getAppConfig, getModelConfig } from "../config/app_config";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
//_deepMergeDicts — 递归合并两个字典
export function _deepMergeDicts(base: Record<string, unknown> | null, override: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...(base || {}) };
    for (const [key, value] of Object.entries(override)) {
        if (typeof value === "object" && value !== null && typeof merged[key] === "object" && merged[key] !== null) {
            merged[key] = _deepMergeDicts(merged[key] as Record<string, unknown>, value as Record<string, unknown>);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

//构建vllm禁用thinking的参数
export function _vllmDisableChatTemplateKwargs(chatTemplateKwargs: Record<string, unknown>): Record<string, unknown> {
    const disableKwargs: Record<string, boolean> = {};
    if ("thinking" in chatTemplateKwargs) {
        disableKwargs.thinking = false;
    }
    if ("enable_thinking" in chatTemplateKwargs) {
        disableKwargs.enable_thinking = false;
    }
    return disableKwargs;
}

//标准化API地址：  场景：用户可能写 api_base 或 base_url，但 OpenAI SDK 只认 base_url。这个函数统一处理。
export function normalizeOpenaiBaseUrl(modelSettings: Record<string, unknown>): void {
    // 如果有 api_base 但没有 base_url → 转换
    if ("api_base" in modelSettings && !("base_url" in modelSettings)) {
        modelSettings.base_url = modelSettings.api_base;
        delete modelSettings.api_base;
    }
    // 如果两个都有 → 删除 api_base，保留 base_url
    else if ("api_base" in modelSettings && "base_url" in modelSettings) {
        delete modelSettings.api_base;
    }
}

export async function createChatModel(
    name?: string,                    // 模型名字（不传就用默认）
    thinkingEnabled: boolean = false, // 是否启用推理
    appConfig?: AppConfig,            // 配置（不传就读 config.yaml）
    attachTracing: boolean = true,    // 是否附加追踪回调
    kwargs?: Record<string, unknown> // 额外参数
): Promise<BaseChatModel> {
    //第一部分读取配置
    const config = appConfig || getAppConfig();
    if (!name) {
        name = config.models[0]?.name;
    }

    const modelConfig = getModelConfig(config, name!);
    if (!modelConfig) {
        throw new Error(`Model ${name} not found in config`);
    }

    //第二部分：准备配置参数
    const modelSettings: Record<string, unknown> = {};
    const excludeKeys = new Set(["use", "name", "display_name", "description",
        "supports_thinking", "supports_vision", "supports_reasoning_effort",
        "when_thinking_enabled", "pricing"]);
    for (const [key, value] of Object.entries(modelConfig)) {
        if (!excludeKeys.has(key) && value !== null && value !== undefined) {
            modelSettings[key] = value;
        }
    }

    //处理thinking
    const hasThinkingSettings = modelConfig.when_thinking_enabled !== undefined;
    let effectiveWte: Record<string, unknown> = {};
    if (modelConfig.when_thinking_enabled) {
        effectiveWte = { ...modelConfig.when_thinking_enabled } as Record<string,
            unknown>;
    }

    //
    if (thinkingEnabled && hasThinkingSettings) {
        if (!modelConfig.supports_thinking) {
            throw new Error(`Model ${name} does not support thinking. Set supports_thinking to true in config.yaml.`);
        }
        if (Object.keys(effectiveWte).length > 0) {
            Object.assign(modelSettings, effectiveWte);
        }
    }


    //
    if (!thinkingEnabled) {
        if (hasThinkingSettings) {
            // 检查是不是 OpenAI 兼容的 extra_body.thinking
            const extraBody = effectiveWte.extra_body as Record<string, unknown> |
                undefined;
            const thinking = extraBody?.thinking as Record<string, unknown> | undefined;
            if (thinking?.type) {
                // OpenAI 兼容网关：禁用 thinking
                modelSettings.extra_body = _deepMergeDicts(
                    modelSettings.extra_body as Record<string, unknown> ?? {},
                    { thinking: { type: "disabled" } }
                );
                modelSettings.reasoning_effort = "minimal";
            } else if (extraBody?.chat_template_kwargs) {
                // vLLM：禁用 thinking
                modelSettings.extra_body = _deepMergeDicts(
                    modelSettings.extra_body as Record<string, unknown> ?? {},
                    {
                        chat_template_kwargs:
                            _vllmDisableChatTemplateKwargs(extraBody.chat_template_kwargs as Record<string,
                                unknown>)
                    }
                );
            } else if (effectiveWte.thinking && typeof effectiveWte.thinking === "object") {
                // Anthropic 原生：禁用 thinking
                modelSettings.thinking = { type: "disabled" };
            }
        }
    }

    // 标准化 api_base → base_url
    normalizeOpenaiBaseUrl(modelSettings);

    //注入默认超时
    _applyStreamChunkTimeOutDefault(modelSettings);
    if (!("stream_usage" in modelSettings)) {
        modelSettings.stream_usage = true;
    }
    // 动态加载模型类
    const { resolveClass } = await import("../reflection/resolvers.js");
    const modelClass = await resolveClass(modelConfig.use);

    // 创建模型实例
    const model = new (modelClass as new (settings: Record<string, unknown>) => BaseChatModel)(modelSettings);


    // 附加追踪回调（LangSmith/Langfuse）
    if (attachTracing) {
        // TODO: 实现 build_tracing_callbacks()
        // const callbacks = buildTracingCallbacks();
        // if (callbacks.length > 0) {
        //     model.callbacks = [...(model.callbacks || []), ...callbacks];
        // }
    }


    return model;
}

//警告未知配置
export function _warnUnkonwnModelSettings(modelSettings: Record<string, unknown>, modelName: string): void {
    const knownKeys = new Set([
        "model", "api_key", "base_url", "max_tokens", "temperature",
        "model_kwargs", "extra_body", "default_headers", "default_query",
        "stream_usage", "stream_chunk_timeout", "reasoning_effort",
        "use_responses_api", "output_version",
    ]);

    // 找出未知的 key
    const unknown = Object.keys(modelSettings).filter(k => !knownKeys.has(k));
    if (unknown.length > 0) {
        console.warn(`Model '${modelName}': unknown config keys: ${unknown.join(", ")}.
  Check for typos.`);
    }
}

const DEFAULT_STREAM_CHUNK_TIMEOUT_SECONDS = 240;
export function _applyStreamChunkTimeOutDefault(modelSettings: Record<string, unknown>): void {
    // 如果用户已经配置了，保留
    if ("stream_chunk_timeout" in modelSettings) return;
    // 注入默认值
    modelSettings.stream_chunk_timeout = DEFAULT_STREAM_CHUNK_TIMEOUT_SECONDS;
}

