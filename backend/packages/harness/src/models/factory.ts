import { getAppConfig, getModelConfig, resolveConfigValue } from "../config/index.js";

/**
 * 模型工厂——根据配置创建 LLM 实例。
 *
 * 对应原项目：backend/packages/harness/deerflow/models/factory.py
 *
 * @param name 模型名字，如 "gpt-4o"
 * @returns LLM 实例
 */
export async function createChatModel(name: string) {
    // 第 1 步：读配置
    const config = getAppConfig();
    const modelConfig = getModelConfig(config, name);
    if (!modelConfig) {
        throw new Error(`Model "${name}" not found in config`);
    }

    
    // 第 2 步：解析 api_key（$OPENAI_API_KEY → 实际值）
    const apiKey = resolveConfigValue(modelConfig.api_key);

    // 第 3 步：根据 use 字段决定用哪个 LangChain 类
    if (modelConfig.use.includes("ChatOpenAI")) {
        // 动态导入，避免启动时加载所有提供商
        const { ChatOpenAI } = await import("@langchain/openai");
        return new ChatOpenAI({
            model: modelConfig.model,
            apiKey: apiKey,
        });
    }

    if (modelConfig.use.includes("ChatAnthropic")) {
        const { ChatAnthropic } = await import("@langchain/anthropic");
        return new ChatAnthropic({
            model: modelConfig.model,
            apiKey: apiKey,
        });
    }

    throw new Error(`Unknown model provider: "${modelConfig.use}"`);
}
