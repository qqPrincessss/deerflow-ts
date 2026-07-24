/**
 * DeerFlow 交互式终端客户端。
 *
 * 对应原项目：backend/packages/harness/deerflow/tui/
 *
 * 交互式 REPL：输入问题 → 流式响应 → 继续对话
 * 支持：多轮对话、Token 统计、命令系统
 */

import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { DeerFlowClient } from "./client.js";
import { stripThinkBlocks } from "./utils/llm_text.js";

// 关掉所有噪音日志
process.env.LANGCHAIN_VERBOSE = "false";
process.env.DEER_FLOW_SILENT = "true";
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _noisePatterns = [
    /^Thinking mode is enabled/,
    /^LLM token usage:/,
    /^--- BEGIN USER INPUT ---/,
    /^--- END USER INPUT ---/,
];
// 拦截 stdout 中的噪音行
process.stdout.write = ((chunk: any) => {
    const str = String(chunk);
    if (_noisePatterns.some((p) => p.test(str.trim()))) return true;
    return _origStdoutWrite(chunk);
}) as typeof process.stdout.write;

// ════════════════════════════════════════════════════════════════════════════════
// 彩虹颜色
// ════════════════════════════════════════════════════════════════════════════════

const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
};

function color(text: string, code: string): string {
    if (!processStdout.isTTY) return text;
    return `${code}${text}${c.reset}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// 历史 & 状态
// ════════════════════════════════════════════════════════════════════════════════

interface HistoryEntry {
    role: "user" | "assistant";
    content: string;
}

const _history: HistoryEntry[] = [];
let _threadId: string | undefined;
let _totalTokens = 0;

// ════════════════════════════════════════════════════════════════════════════════
// 显示
// ════════════════════════════════════════════════════════════════════════════════

function showBanner(): void {
    console.log();
    console.log(color(`  ┌──────────────────────────────────────────┐`, c.cyan));
    console.log(color(`  │           DeerFlow  Terminal             │`, c.cyan));
    console.log(color(`  │           交互式 AI 助手                  │`, c.cyan));
    console.log(color(`  └──────────────────────────────────────────┘`, c.cyan));
    console.log();
    console.log(color(`  💬 直接输入问题，回车发送`, c.dim));
    console.log(color(`  ⚡ /exit 退出  /clear 清屏  /help 命令列表`, c.dim));
    console.log();
}

function showHelp(): void {
    console.log();
    console.log(color(`  ── 命令 ──`, c.bold));
    console.log(`  ${color("/exit", c.yellow)}   退出程序`);
    console.log(`  ${color("/quit", c.yellow)}   退出程序`);
    console.log(`  ${color("/clear", c.yellow)}  清屏`);
    console.log(`  ${color("/help", c.yellow)}   显示此帮助`);
    console.log(`  ${color("/hist", c.yellow)}   显示对话历史`);
    console.log(`  ${color("/stats", c.yellow)}  显示 Token 统计`);
    console.log();
}

function showHistory(): void {
    if (_history.length === 0) {
        console.log(color(`  (暂无对话)`, c.dim));
        return;
    }
    console.log();
    console.log(color(`  ── 对话历史 ──`, c.bold));
    for (const entry of _history) {
        const tag = entry.role === "user" ? color("You", c.green) : color("AI", c.blue);
        const text = entry.content.slice(0, 100).replace(/\n/g, " ");
        console.log(`  ${tag}: ${text}${entry.content.length > 100 ? "..." : ""}`);
    }
    console.log();
}

function showStats(): void {
    console.log();
    console.log(color(`  ── 统计 ──`, c.bold));
    console.log(`  消息: ${_history.length}`);
    console.log(`  Token: ${_totalTokens}`);
    console.log();
}

function showUsage(usage: Record<string, number>): void {
    const total = usage.total_tokens ?? 0;
    if (total > 0) {
        _totalTokens += total;
        console.log(color(`  📊 +${total} tokens  (累计 ${_totalTokens})`, c.dim));
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 主循环
// ════════════════════════════════════════════════════════════════════════════════

export async function runTui(): Promise<void> {
    const client = new DeerFlowClient();
    const rl = createInterface({
        input: processStdin,
        output: processStdout,
        prompt: "",
    });

    showBanner();

    while (true) {
        const input = await rl.question(color(`\n  ${color("You", c.green)}> `, c.reset));
        const trimmed = input.trim();

        if (!trimmed) continue;

        // ── 命令 ──
        if (trimmed.startsWith("/")) {
            const cmd = trimmed.toLowerCase();
            if (cmd === "/exit" || cmd === "/quit") {
                console.log(color(`\n  👋 再见！本次共用 ${_totalTokens} tokens\n`, c.yellow));
                break;
            }
            if (cmd === "/clear") { console.clear(); showBanner(); continue; }
            if (cmd === "/help") { showHelp(); continue; }
            if (cmd === "/hist" || cmd === "/history") { showHistory(); continue; }
            if (cmd === "/stats" || cmd === "/stat") { showStats(); continue; }
            console.log(color(`  未知命令: ${trimmed}。输入 /help 查看可用命令`, c.red));
            continue;
        }

        // ── 发送 ──
        _history.push({ role: "user", content: trimmed });

        process.stdout.write(color(`  ${color("AI", c.blue)}> `, c.reset));

        let fullResponse = "";
        let usage: Record<string, number> = {};

        try {
            for await (const event of client.stream(trimmed, { threadId: _threadId })) {
                if (event.type === "messages-tuple" && event.data.type === "ai") {
                    const raw = (event.data.content as string) ?? "";
                    const clean = stripThinkBlocks(raw);
                    if (clean) {
                        fullResponse += clean;
                        process.stdout.write(clean);
                    }
                }
                if (event.type === "end") {
                    usage = event.data.usage as Record<string, number>;
                }
            }
        } catch (err) {
            console.log();
            console.log(color(`  ❌ ${(err as Error).message ?? err}`, c.red));
            continue;
        }

        if (fullResponse) {
            _history.push({ role: "assistant", content: fullResponse });
            showUsage(usage);
        }
        console.log();
    }

    rl.close();
}

// 直接运行
runTui().catch((err) => {
    console.error(color("  ❌ 错误:", c.red), err.message ?? err);
    process.exit(1);
});
