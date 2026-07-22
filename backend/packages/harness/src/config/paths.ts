export const VIRTUAL_PATH_PREFIX = "/mnt/user-data";

// 安全 ID 正则（只允许字母、数字、下划线、连字符）
const SAFE_ID_RE = /^[A-Za-z0-9_\-]+$/;

export function validateThreadId(threadId: string): string {
    if (!SAFE_ID_RE.test(threadId)) {
        throw new Error(`Invalid thread_id: only alphanumeric, hyphens, underscores allowed`);
    }
    return threadId;
}

export function validateUserId(userId: string): string {
    if (!SAFE_ID_RE.test(userId)) {
        throw new Error(`Invalid user_id: only alphanumeric, hyphens, underscores allowed`);
    }
    return userId;
}
export class Paths {
    private _baseDir?: string;

    // 基础目录（所有数据的根）
    get baseDir(): string {
        if (this._baseDir) return this._baseDir;
        return process.env.DEER_FLOW_HOME || ".deer-flow";
    }

    userDir(userId: string): string {
        return `${this.baseDir}/users/${validateUserId(userId)}`;
    }

    threadDir(threadId: string, userId?: string): string {
        const safeThreadId = validateThreadId(threadId);
        if (userId) {
            return `${this.userDir(userId)}/threads/${safeThreadId}`;
        }
        return `${this.baseDir}/threads/${safeThreadId}`;
    }

    sandboxWorkDir(threadId: string, userId?: string): string {
        return `${this.threadDir(threadId, userId)}/user-data/workspace`;
    }

    sandboxUploadsDir(threadId: string, userId?: string): string {
        return `${this.threadDir(threadId, userId)}/user-data/uploads`;
    }

    sandboxOutputsDir(threadId: string, userId?: string): string {
        return `${this.threadDir(threadId, userId)}/user-data/outputs`;
    }

    /**
     * 创建线程的所有标准目录。
     */
    ensureThreadDirs(threadId: string, userId?: string): void {
        const dirs = [
            this.sandboxWorkDir(threadId, userId),
            this.sandboxUploadsDir(threadId, userId),
            this.sandboxOutputsDir(threadId, userId),
        ];
        for (const dir of dirs) {
            const { mkdirSync } = require("node:fs");
            mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * 删除线程的所有数据。
     */
    deleteThreadDir(threadId: string, userId?: string): void {
        const { rmSync } = require("node:fs");
        const dir = this.threadDir(threadId, userId);
        rmSync(dir, { recursive: true, force: true });
    }

    /**
     * 解析虚拟路径到实际物理路径。
     */
    resolveVirtualPath(threadId: string, virtualPath: string, userId?: string): string {
        const stripped = virtualPath.replace(/^\/+/, "");
        const prefix = VIRTUAL_PATH_PREFIX.replace(/^\/+/, "");

        if (!stripped.startsWith(prefix)) {
            throw new Error(`Path must start with ${VIRTUAL_PATH_PREFIX}`);
        }

        const relative = stripped.slice(prefix.length).replace(/^\/+/, "");
        const base = `${this.threadDir(threadId, userId)}/user-data`;
        return `${base}/${relative}`;
    }
}

let _defaultPaths: Paths | null = null;

export function getPaths(): Paths {
    if (!_defaultPaths) {
        _defaultPaths = new Paths();
    }
    return _defaultPaths;
}
