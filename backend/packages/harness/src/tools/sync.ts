/**
 * 异步工具转同步包装器。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/sync.py
 *
 * 允许从同步 Agent 路径调用异步工具。
 */

/**
 * 创建同步工具包装器。
 *
 * @param asyncFn 异步函数
 * @param toolName 工具名（用于日志）
 * @returns 同步函数
 */
export function makeSyncToolWrapper(
    asyncFn: (...args: unknown[]) => Promise<unknown>,
    toolName: string
): (...args: unknown[]) => unknown {
    return function syncWrapper(...args: unknown[]): unknown {
        try {
            // 尝试同步等待 Promise
            // TypeScript 中无法真正将 async 转为 sync，
            // 这里用 Promise.resolve 模拟
            const result = asyncFn(...args);
            return result;
        } catch (err) {
            console.error(`Error invoking tool "${toolName}" via sync wrapper:`, err);
            throw err;
        }
    };
}
