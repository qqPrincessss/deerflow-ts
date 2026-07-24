/**
 * DeerFlow CLI — 命令行入口。
 */

import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeerFlowAgent } from "./agents/factory.js";

async function main() {
    const question = process.argv.slice(2).join(" ") || "你好，请用中文回复";

    // 读取配置
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";
    const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

    if (!openaiKey && !anthropicKey) {
        console.error("❌ 请设置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY");
        console.error("");
        console.error("复制 .env 文件并填入你的 Key:");
        console.error("  copy .env .env.local");
        process.exit(1);
    }

    // 创建模型（优先用 OpenAI）
    const model = openaiKey
        ? new ChatOpenAI({
              apiKey: openaiKey,
              model: openaiModel,
              configuration: baseUrl !== "https://api.openai.com/v1" ? { baseURL: baseUrl } : undefined,
          })
        : new ChatAnthropic({
              apiKey: anthropicKey!,
              model: anthropicModel,
              topP: 0.99,
              clientOptions: anthropicBaseUrl !== "https://api.anthropic.com/v1"
                  ? { baseURL: anthropicBaseUrl }
                  : undefined,
          });

    const agent = createDeerFlowAgent({
        model,
        systemPrompt: "你是一个有用的助手，用中文回复",
        tools: [],
        name: "cli-agent",
        features: {},
    });

    console.log(`\n🤖 提问: ${question}\n`);
    console.log("⏳ AI 思考中...\n");

    const result = await agent.invoke(question, { maxTurns: 5 });
    console.log(`💬 ${result.finalOutput}\n`);
    console.log(`📊 ${result.messages.length} 条消息`);
}

main().catch(console.error);
