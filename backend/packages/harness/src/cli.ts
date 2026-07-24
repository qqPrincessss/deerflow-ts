/**
 * DeerFlow CLI — 命令行入口。
 *
 * 对应原项目：backend/packages/harness/deerflow/tui/cli.py
 *
 * 支持：
 *   deerflow "问题"           → 一次性问答
 *   deerflow --stream "问题"   → 流式输出
 *   deerflow --models         → 列出模型
 *   deerflow --help           → 帮助信息
 */

import { DeerFlowClient } from "./client.js";
import { extractResponseText } from "./utils/llm_text.js";
import { stripThinkBlocks } from "./utils/llm_text.js";

function printHelp(): void {
    console.log(`
DeerFlow — Terminal AI Agent

用法:
  deerflow "你的问题"             一次问答，打印结果
  deerflow --stream "你的问题"    流式输出，逐段显示
  deerflow --models              列出可用模型
  deerflow --help                 显示此帮助

环境变量:
  ANTHROPIC_API_KEY         API Key
  DEER_FLOW_CONFIG_PATH     config.yaml 路径
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printHelp();
        return;
    }

    if (args[0] === "--models") {
        const client = new DeerFlowClient();
        const result = client.listModels();
        const models = result.models as Array<Record<string, unknown>>;
        console.log("\n可用模型:\n");
        for (const m of models) {
            const thinking = m.supports_thinking ? " 🧠" : "";
            console.log(`  ${m.name}${thinking}`);
            if (m.description) console.log(`    ${m.description}`);
            console.log();
        }
        return;
    }

    const isStream = args[0] === "--stream";
    const question = isStream ? args.slice(1).join(" ") : args.join(" ");

    if (!question) {
        console.error("❌ 请提供问题");
        printHelp();
        process.exit(1);
    }

    const client = new DeerFlowClient();

    if (isStream) {
        process.stdout.write("\n");
        for await (const event of client.stream(question)) {
            if (event.type === "messages-tuple" && event.data.type === "ai") {
                const raw = (event.data.content as string) ?? "";
                const clean = stripThinkBlocks(raw);
                if (clean) process.stdout.write(clean);
            }
            if (event.type === "end") {
                const usage = event.data.usage as Record<string, number>;
                if (usage?.total_tokens) {
                    process.stdout.write(`\n\n───\n📊 ${usage.total_tokens} tokens\n`);
                }
            }
        }
        process.stdout.write("\n");
    } else {
        console.log("\n⏳ ");
        const answer = await client.chat(question);
        const clean = stripThinkBlocks(answer);
        console.log(clean);
        console.log();
    }
}

main().catch((err) => {
    console.error("❌ 错误:", err.message ?? err);
    process.exit(1);
});
