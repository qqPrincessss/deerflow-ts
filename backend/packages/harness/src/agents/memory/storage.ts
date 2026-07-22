/**
 * 记忆存储提供者。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/memory/storage.py
 *
 * 提供基于文件的记忆存储实现。
 */

import { statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ─── 接口定义 ──────────────────────────────────────────────────

/** 记忆存储接口 */
interface MemoryStorage {
    load(agentName?: string, userId?: string): Promise<Record<string, unknown>>;
    reload(agentName?: string, userId?: string): Promise<Record<string, unknown>>;
    save(memoryData: Record<string, unknown>, agentName?: string, userId?: string): Promise<boolean>;
}

// ─── 工具函数 ──────────────────────────────────────────────────

/** 当前 UTC 时间的 ISO-8601 字符串（带 Z 后缀） */
function utcNowIsoZ(): string {
    return new Date().toISOString();
}

/** 创建空的记忆结构 */
export function createEmptyMemory(): Record<string, unknown> {
    return {
        version: "1.0",
        lastUpdated: utcNowIsoZ(),
        user: {
            workContext: { summary: "", updatedAt: "" },
            personalContext: { summary: "", updatedAt: "" },
            topOfMind: { summary: "", updatedAt: "" },
        },
        history: {
            recentMonths: { summary: "", updatedAt: "" },
            earlierContext: { summary: "", updatedAt: "" },
            longTermBackground: { summary: "", updatedAt: "" },
        },
        facts: [],
    };
}

/** 获取记忆文件路径 */
function getMemoryFilePath(agentName?: string, userId?: string): string {
    const baseDir = process.env.DEER_FLOW_HOME || ".deer-flow";

    if (userId && agentName) {
        return `${baseDir}/users/${userId}/agents/${agentName}/memory.json`;
    }
    if (userId) {
        return `${baseDir}/users/${userId}/memory.json`;
    }
    if (agentName) {
        return `${baseDir}/agents/${agentName.toLowerCase()}/memory.json`;
    }
    return `${baseDir}/memory.json`;
}

// ─── FileMemoryStorage 类 ──────────────────────────────────────────────────

export class FileMemoryStorage implements MemoryStorage {
    private cache: Map<string, { data: Record<string, unknown>; mtime: number | null }>;
    private lock: boolean = false;
    private waitQueue: Array<() => void> = [];

    constructor() {
        this.cache = new Map();
    }

    /** 获取锁 */
    private async acquire(): Promise<void> {
        if (!this.lock) {
            this.lock = true;
            return;
        }
        return new Promise((resolve) => {
            this.waitQueue.push(resolve);
        });
    }

    /** 释放锁 */
    private release(): void {
        if (this.waitQueue.length > 0) {
            const next = this.waitQueue.shift()!;
            next();
        } else {
            this.lock = false;
        }
    }

    /** 校验 agent 名称是否安全 */
    private _validateAgentName(agentName: string): void {
        if (!agentName) {
            throw new Error("Agent name must be a non-empty string.");
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(agentName)) {
            throw new Error(`Invalid agent name: only alphanumeric, hyphens, and underscores allowed.`);
        }
    }

    /** 生成缓存 key */
    private static _cacheKey(agentName?: string, userId?: string): string {
        return `${userId || ""}:${agentName || ""}`;
    }

    /** 从文件中加载记忆数据 */
    private _loadMemoryFromFile(agentName?: string, userId?: string): Record<string, unknown> {
        const filePath = getMemoryFilePath(agentName, userId);

        try {
            statSync(filePath); // 检查文件是否存在
        } catch {
            return createEmptyMemory();
        }

        try {
            const content = readFileSync(filePath, "utf-8");
            return JSON.parse(content);
        } catch {
            console.warn(`Failed to load memory file: ${filePath}`);
            return createEmptyMemory();
        }
    }

    async load(agentName?: string, userId?: string): Promise<Record<string, unknown>> {
        await this.acquire();
        try {
            const filePath = getMemoryFilePath(agentName, userId);
            const cacheKey = FileMemoryStorage._cacheKey(agentName, userId);

            let currentMtime: number | null = null;
            try {
                currentMtime = statSync(filePath).mtimeMs;
            } catch {
                currentMtime = null;
            }

            const cached = this.cache.get(cacheKey);
            if (cached && cached.mtime === currentMtime) {
                return cached.data;
            }

            const memoryData = this._loadMemoryFromFile(agentName, userId);
            this.cache.set(cacheKey, { data: memoryData, mtime: currentMtime });
            return memoryData;
        } finally {
            this.release();
        }
    }

    async reload(agentName?: string, userId?: string): Promise<Record<string, unknown>> {
        await this.acquire();
        try {
            const filePath = getMemoryFilePath(agentName, userId);
            const memoryData = this._loadMemoryFromFile(agentName, userId);
            const cacheKey = FileMemoryStorage._cacheKey(agentName, userId);

            let mtime: number | null = null;
            try {
                mtime = statSync(filePath).mtimeMs;
            } catch {
                mtime = null;
            }

            this.cache.set(cacheKey, { data: memoryData, mtime });
            return memoryData;
        } finally {
            this.release();
        }
    }

    async save(memoryData: Record<string, unknown>, agentName?: string, userId?: string): Promise<boolean> {
        const filePath = getMemoryFilePath(agentName, userId);
        await this.acquire();
        try {
            const cacheKey = FileMemoryStorage._cacheKey(agentName, userId);

            mkdirSync(dirname(filePath), { recursive: true });

            const dataToSave = { ...memoryData, lastUpdated: utcNowIsoZ() };

            const tempPath = `${filePath}.${randomUUID()}.tmp`;
            writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), "utf-8");
            renameSync(tempPath, filePath);

            let mtime: number | null = null;
            try {
                mtime = statSync(filePath).mtimeMs;
            } catch {
                mtime = null;
            }

            this.cache.set(cacheKey, { data: dataToSave, mtime });
            return true;
        } catch (err) {
            console.error(`Failed to save memory file: ${filePath}`, err);
            return false;
        } finally {
            this.release();
        }
    }
}

// ─── 单例 ──────────────────────────────────────────────────

let _storageInstance: MemoryStorage | null = null;

export function getMemoryStorage(): MemoryStorage {
    if (_storageInstance) {
        return _storageInstance;
    }
    _storageInstance = new FileMemoryStorage();
    return _storageInstance;
}
