/**
 * MCP 会话池 — 管理持久化的 MCP 会话。
 *
 * 对应原项目：backend/packages/harness/deerflow/mcp/session_pool.py
 *
 * 问题：每次工具调用创建新会话，有状态 MCP 服务器会丢失状态。
 * 解决：按 (server_name, scope_key) 缓存会话，LRU 淘汰。
 */

// ════════════════════════════════════════════════════════════════════════════════
// 会话池
// ════════════════════════════════════════════════════════════════════════════════

export interface McpSession {
    /** 发送 JSON-RPC 请求 */
    request(method: string, params?: Record<string, unknown>): Promise<unknown>;
    /** 关闭会话 */
    close(): Promise<void>;
}

interface PoolEntry {
    session: McpSession;
    serverName: string;
    scopeKey: string;
    createdAt: number;
    lastUsed: number;
}

export class McpSessionPool {
    private _maxSessions = 256;
    private _entries = new Map<string, PoolEntry>();
    // 正在创建的 Promise（防并发）
    private _inflight = new Map<string, Promise<McpSession>>();

    private _key(serverName: string, scopeKey: string): string {
        return `${serverName}:${scopeKey}`;
    }

    /**
     * 获取或创建持久化 MCP 会话。
     */
    async getSession(
        serverName: string,
        scopeKey: string,
        connection: Record<string, unknown>,
        createSession: (conn: Record<string, unknown>) => Promise<McpSession>,
    ): Promise<McpSession> {
        const key = this._key(serverName, scopeKey);

        // 检查现有条目
        const existing = this._entries.get(key);
        if (existing) {
            existing.lastUsed = Date.now();
            this._entries.delete(key); // 移到末尾（LRU）
            this._entries.set(key, existing);
            return existing.session;
        }

        // 检查是否有正在创建的
        const inflight = this._inflight.get(key);
        if (inflight) return inflight;

        // 创建新会话
        const createPromise = createSession(connection);
        this._inflight.set(key, createPromise);

        try {
            const session = await createPromise;
            this._inflight.delete(key);

            // LRU 淘汰
            while (this._entries.size >= this._maxSessions) {
                const oldestKey = this._entries.keys().next().value;
                if (oldestKey !== undefined) {
                    const oldest = this._entries.get(oldestKey)!;
                    oldest.session.close().catch(() => {});
                    this._entries.delete(oldestKey);
                }
            }

            this._entries.set(key, {
                session,
                serverName,
                scopeKey,
                createdAt: Date.now(),
                lastUsed: Date.now(),
            });

            return session;
        } catch (error) {
            this._inflight.delete(key);
            throw error;
        }
    }

    /**
     * 关闭指定 scope 的所有会话。
     */
    async closeScope(scopeKey: string): Promise<void> {
        const keys: string[] = [];
        for (const [k, entry] of this._entries) {
            if (entry.scopeKey === scopeKey) keys.push(k);
        }
        await Promise.all(keys.map((k) => this._closeKey(k)));
    }

    /**
     * 关闭指定服务器的所有会话。
     */
    async closeServer(serverName: string): Promise<void> {
        const keys: string[] = [];
        for (const [k, entry] of this._entries) {
            if (entry.serverName === serverName) keys.push(k);
        }
        await Promise.all(keys.map((k) => this._closeKey(k)));
    }

    /**
     * 关闭所有会话。
     */
    async closeAll(): Promise<void> {
        const keys = [...this._entries.keys()];
        await Promise.all(keys.map((k) => this._closeKey(k)));
    }

    private async _closeKey(key: string): Promise<void> {
        const entry = this._entries.get(key);
        if (!entry) return;
        this._entries.delete(key);
        try {
            await entry.session.close();
        } catch { /* 忽略关闭错误 */ }
    }

    get size(): number {
        return this._entries.size;
    }

    get activeKeys(): string[] {
        return [...this._entries.keys()];
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 全局单例
// ════════════════════════════════════════════════════════════════════════════════

let _pool: McpSessionPool | null = null;

export function getSessionPool(): McpSessionPool {
    if (!_pool) _pool = new McpSessionPool();
    return _pool;
}

export function resetSessionPool(): void {
    if (_pool) {
        _pool.closeAll().catch(() => {});
        _pool = null;
    }
}
