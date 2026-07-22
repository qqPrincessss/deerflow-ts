/**
 * 线程数据中间件 — 创建线程目录结构。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/thread_data_middleware.py
 *
 * 每个对话（线程）有独立的工作目录：
 *   {baseDir}/threads/{threadId}/user-data/workspace
 *   {baseDir}/threads/{threadId}/user-data/uploads
 *   {baseDir}/threads/{threadId}/user-data/outputs
 *
 * 生命周期：
 *   默认 lazy_init=true — 只计算路径，目录在沙箱工具首次使用时创建
 *   lazy_init=false — 立即创建目录
 */

import { getPaths } from "../../config/paths.js";
import { getEffectiveUserId } from "../../runtime/user_context.js";
import { type ThreadDataState } from "../../agents/thread_state.js";

// ════════════════════════════════════════════════════════════════════════════════
// 主逻辑
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 计算线程的目录路径。
 */
function _getThreadPaths(threadId: string, userId?: string): ThreadDataState {
    const paths = getPaths();
    return {
        workspace_path: paths.sandboxWorkDir(threadId, userId),
        uploads_path: paths.sandboxUploadsDir(threadId, userId),
        outputs_path: paths.sandboxOutputsDir(threadId, userId),
    };
}

/**
 * 创建线程目录并返回路径。
 */
function _createThreadDirectories(threadId: string, userId?: string): ThreadDataState {
    getPaths().ensureThreadDirs(threadId, userId);
    return _getThreadPaths(threadId, userId);
}

/**
 * 线程数据中间件入口。
 *
 * 在 Agent 运行前调用，计算线程的 workspace/uploads/outputs 路径，
 * 可选是否立即创建目录。
 *
 * @param options.threadId 线程 ID
 * @param options.context 运行时上下文（用于提取 run_id）
 * @param options.lazyInit 延迟初始化（默认 true，只算路径不创目录）
 * @param options.messages 当前消息列表（可选，用于标记最后一条用户消息）
 * @returns 要合并到 state 的数据 { thread_data, messages? }
 */
export function setupThreadData(options: {
    threadId: string;
    context?: Record<string, unknown> | null;
    lazyInit?: boolean;
    messages?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
    const { threadId, context, lazyInit = true, messages } = options;
    const userId = getEffectiveUserId();

    // 计算或创建路径
    let paths: ThreadDataState;
    if (lazyInit) {
        paths = _getThreadPaths(threadId, userId);
    } else {
        paths = _createThreadDirectories(threadId, userId);
    }

    const result: Record<string, unknown> = {
        thread_data: paths,
    };

    // 标记最后一条用户消息（加 run_id 和 timestamp）
    if (messages && messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.type === "human") {
            const additionalKwargs: Record<string, unknown> = {
                ...((lastMsg.additional_kwargs as Record<string, unknown>) ?? {}),
                run_id: context?.run_id ?? null,
                timestamp: new Date().toISOString(),
            };
            const newMessages = [...messages];
            newMessages[newMessages.length - 1] = {
                ...lastMsg,
                name: (lastMsg.name as string) || "user-input",
                additional_kwargs: additionalKwargs,
            };
            result.messages = newMessages;
        }
    }

    return result;
}
