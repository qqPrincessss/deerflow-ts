/**
 * 技能存储工厂 — 管理 SkillStorage 实例的创建和缓存。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/storage/__init__.py
 */

import { type Skill } from "./types.js";
import { LocalSkillStorage, UserScopedSkillStorage } from "./storage/local_skill_storage.js";

// ════════════════════════════════════════════════════════════════════════════════
// 简易锁（JS 单线程，但防止 async 并发）
// ════════════════════════════════════════════════════════════════════════════════

class Lock {
    private _locked = false;
    private _queue: Array<() => void> = [];

    acquire(): Promise<() => void> {
        if (!this._locked) {
            this._locked = true;
            return Promise.resolve(() => { this._locked = false; this._drain(); });
        }
        return new Promise((resolve) => {
            this._queue.push(() => {
                this._locked = true;
                resolve(() => { this._locked = false; this._drain(); });
            });
        });
    }

    private _drain(): void {
        const next = this._queue.shift();
        if (next) setTimeout(next, 0);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 接口定义
// ════════════════════════════════════════════════════════════════════════════════

export interface SkillStorage {
    getSkillsRootPath(): string;
    getContainerRoot(): string;
    loadSkills(options?: { enabled_only?: boolean }): Skill[];
    validateSkillFilePath(skillFile: string): string;
    getCustomSkillDir(name: string): string;
    getCustomSkillFile(name: string): string;
    customSkillExists(name: string): boolean;
    publicSkillExists(name: string): boolean;
    readCustomSkill(name: string): string;
    writeCustomSkill(name: string, content: string): void;
    deleteCustomSkill(name: string): void;
}

// ════════════════════════════════════════════════════════════════════════════════
// 全局单例
// ════════════════════════════════════════════════════════════════════════════════

let _defaultStorage: SkillStorage | null = null;
const _storageLock = new Lock();

export function getOrNewSkillStorage(): SkillStorage {
    if (_defaultStorage !== null) return _defaultStorage;

    // 冷启动（单线程，无需锁）
    _defaultStorage = new LocalSkillStorage() as unknown as SkillStorage;
    return _defaultStorage;
}

export function setSkillStorage(storage: SkillStorage): void {
    _defaultStorage = storage;
}

export function resetSkillStorage(): void {
    _defaultStorage = null;
    _userScopedStorages.clear();
}

// ════════════════════════════════════════════════════════════════════════════════
// Per-user 存储缓存（LRU）
// ════════════════════════════════════════════════════════════════════════════════

const _MAX_USER_SCOPED_STORAGES = 64;
const _userScopedStorages = new Map<string, SkillStorage>();

export function getOrNewUserSkillStorage(userId: string): SkillStorage {
    const safeId = userId.replace(/[^A-Za-z0-9_\-]/g, "_");

    const cached = _userScopedStorages.get(safeId);
    if (cached !== undefined) {
        _userScopedStorages.delete(safeId);
        _userScopedStorages.set(safeId, cached);
        return cached;
    }

    const storage: SkillStorage = new UserScopedSkillStorage(safeId) as unknown as SkillStorage;
    _userScopedStorages.set(safeId, storage);

    while (_userScopedStorages.size > _MAX_USER_SCOPED_STORAGES) {
        const firstKey = _userScopedStorages.keys().next().value;
        if (firstKey !== undefined) _userScopedStorages.delete(firstKey);
    }

    return storage;
}

export function resetUserSkillStorage(userId?: string): void {
    if (userId) {
        const safeId = userId.replace(/[^A-Za-z0-9_\-]/g, "_");
        _userScopedStorages.delete(safeId);
    } else {
        _userScopedStorages.clear();
    }
}
