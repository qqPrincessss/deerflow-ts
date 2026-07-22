/**
 * 文件操作锁 — 防止同一沙箱内并发操作同一文件。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/file_operation_lock.py
 *
 * 使用 WeakMap 防止长时间运行进程中的内存泄漏。
 * 当锁不再被任何线程引用时自动释放。
 */

import { type Sandbox } from "./sandbox.js";

const _fileOperationLocks = new Map<string, { lock: Promise<void>; unlock: () => void }>();

/**
 * 生成锁的 key。
 */
function getFileOperationLockKey(sandbox: Sandbox, path: string): string {
    const sandboxId = sandbox.id || `instance:${sandbox}`;
    return `${sandboxId}:${path}`;
}

/**
 * 获取文件操作锁。
 * 同一 (sandbox_id, path) 的并发操作会排队等待。
 */
export async function withFileOperationLock<T>(
    sandbox: Sandbox,
    path: string,
    fn: () => Promise<T>
): Promise<T> {
    const key = getFileOperationLockKey(sandbox, path);

    // 获取之前的锁（如果有）
    const existing = _fileOperationLocks.get(key);
    if (existing) {
        // 等待之前的操作完成
        await existing.lock;
    }

    // 创建新的锁
    let unlock: () => void;
    const lock = new Promise<void>((resolve) => {
        unlock = resolve;
    });

    _fileOperationLocks.set(key, { lock: lock, unlock: unlock! });

    try {
        return await fn();
    } finally {
        unlock!();
        _fileOperationLocks.delete(key);
    }
}
