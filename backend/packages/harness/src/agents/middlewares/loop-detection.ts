/**
 * LoopDetectionMiddleware — 检测 LLM 是否陷入工具调用循环。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/loop_detection_middleware.py
 *
 * 问题：LLM 有时会卡住，反复调同一个工具（比如一直执行同一个失败的 bash 命令）。
 * 解决：记录最近 N 次工具调用，发现重复就警告或停止。
 *
 * 两层防护：
 * 1. 完全相同的调用（name + args 都一样）→ 警告 → 停止
 * 2. 同一个工具类型调用太多次（不管 args）→ 警告 → 停止
 */

// ─── 配置 ──────────────────────────────────────────────────

/** 警告阈值：相同的调用出现 3 次就注入警告 */
const WARN_THRESHOLD = 3;

/** 硬限制：相同的调用出现 5 次就强制停止 */
const HARD_LIMIT = 5;

/** 窗口大小：只记录最近 20 次调用 */
const WINDOW_SIZE = 20;

/** 同工具类型警告阈值：同一个工具调 30 次就警告 */
const TOOL_FREQ_WARN = 30;

/** 同工具类型硬限制：同一个工具调 50 次就停止 */
const TOOL_FREQ_HARD_LIMIT = 50;

/** 每次运行最多注入 4 次警告 */
const MAX_WARNINGS_PER_RUN = 4;

// ─── 状态 ──────────────────────────────────────────────────

/** 最近的工具调用记录（滑动窗口） */
const recentCalls: string[] = [];

/** 当前运行已注入的警告数 */
let warningCount = 0;

/** 每个工具类型的调用次数 */
const toolFrequency: Map<string, number> = new Map();

// ─── 工具调用标准化 ──────────────────────────────────────

/**
 * 把工具调用参数标准化成稳定的 key。
 *
 * 原项目处理了很多边界情况：
 * - args 可能是字符串（JSON）或对象
 * - read_file 的行号要分桶（每 200 行一个桶）
 * - write_file/str_replace 要哈希内容（因为同一文件可能写不同内容）
 */
function normalizeToolCall(name: string, args: Record<string, unknown>): string {
    // 基础 key：工具名
    let key = name;

    // read_file：路径 + 行号分桶（每 200 行一个桶）
    if (name === "read_file") {
        const path = String(args.path || "");
        const startLine = Number(args.start_line || 1);
        const endLine = Number(args.end_line || startLine);
        const bucketSize = 200;
        const bucketStart = Math.floor((Math.max(startLine, 1) - 1) / bucketSize);
        const bucketEnd = Math.floor((Math.max(endLine, 1) - 1) / bucketSize);
        return `${key}:${path}:${bucketStart}-${bucketEnd}`;
    }

    // write_file/str_replace：路径 + 内容哈希（简化版用内容长度代替）
    if (name === "write_file" || name === "str_replace") {
        const path = String(args.path || "");
        const content = String(args.content || args.new_str || "");
        return `${key}:${path}:${content.length}`;
    }

    // bash：命令内容
    if (name === "bash") {
        return `${key}:${String(args.command || "")}`;
    }

    // 其他工具：工具名 + 所有 args 的排序 JSON
    const sortedArgs = JSON.stringify(args, Object.keys(args).sort());
    return `${key}:${sortedArgs}`;
}

// ─── 核心检测逻辑 ──────────────────────────────────────

export interface LoopCheckResult {
    /** 是否检测到循环 */
    isLoop: boolean;
    /** 是否需要停止 */
    shouldStop: boolean;
    /** 警告消息（如果有） */
    warning: string | null;
}

/**
 * 检测工具调用是否在循环。
 *
 * @param toolName 工具名
 * @param args 工具参数
 * @returns 检测结果
 */
export function checkLoop(toolName: string, args: Record<string, unknown>): LoopCheckResult {
    const key = normalizeToolCall(toolName, args);

    // ── 第一层：完全相同的调用检测 ──

    // 统计这个 key 在最近调用中出现了几次
    const sameCallCount = recentCalls.filter((call) => call === key).length;

    // 记录这次调用（保持窗口大小）
    recentCalls.push(key);
    if (recentCalls.length > WINDOW_SIZE) {
        recentCalls.shift(); // 移除最旧的
    }

    // 超过硬限制 → 强制停止
    if (sameCallCount >= HARD_LIMIT) {
        return {
            isLoop: true,
            shouldStop: true,
            warning: `Loop detected: "${toolName}" called ${sameCallCount + 1} times with the same arguments. Forcing stop.`,
        };
    }

    // 超过警告阈值 → 注入警告
    if (sameCallCount >= WARN_THRESHOLD) {
        if (warningCount < MAX_WARNINGS_PER_RUN) {
            warningCount++;
            return {
                isLoop: true,
                shouldStop: false,
                warning: `Warning: "${toolName}" has been called ${sameCallCount + 1} times with the same arguments. Try a different approach.`,
            };
        }
        // 警告次数用完了，直接停止
        return {
            isLoop: true,
            shouldStop: true,
            warning: `Loop detected: "${toolName}" still repeating after ${MAX_WARNINGS_PER_RUN} warnings. Forcing stop.`,
        };
    }

    // ── 第二层：同工具类型频率检测 ──

    const currentCount = (toolFrequency.get(toolName) || 0) + 1;
    toolFrequency.set(toolName, currentCount);

    if (currentCount >= TOOL_FREQ_HARD_LIMIT) {
        return {
            isLoop: true,
            shouldStop: true,
            warning: `Tool frequency limit: "${toolName}" called ${currentCount} times. Forcing stop.`,
        };
    }

    if (currentCount >= TOOL_FREQ_WARN && currentCount % 10 === 0) {
        return {
            isLoop: false,
            shouldStop: false,
            warning: `Warning: "${toolName}" has been called ${currentCount} times. Consider if this is necessary.`,
        };
    }

    // 没有循环
    return {
        isLoop: false,
        shouldStop: false,
        warning: null,
    };
}

/**
 * 重置循环检测状态（每次新运行时调用）。
 */
export function resetLoopDetection(): void {
    recentCalls.length = 0;
    toolFrequency.clear();
    warningCount = 0;
}
