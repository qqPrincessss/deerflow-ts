/**
 * 沙箱提供者 — 单例生命周期管理。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/sandbox_provider.py
 *
 * 全局单例，线程安全（通过异步锁），支持延迟初始化 + 配置加载。
 */

import { type Sandbox } from "./sandbox.js";
import { getAppConfig } from "../config/app_config.js";
import { resolveClass } from "../reflection/resolvers.js";

// ════════════════════════════════════════════════════════════════
// 接口定义
// ════════════════════════════════════════════════════════════════

export interface SandboxProvider {
    usesThreadDataMounts?: boolean;
    needsUploadPermissionAdjustment?: boolean;

    /** 获取沙箱环境，返回沙箱 ID */
    acquire(threadId?: string, userId?: string): Promise<string>;
    /** 按 ID 获取沙箱 */
    get(sandboxId: string): Sandbox | null;
    /** 释放沙箱 */
    release(sandboxId: string): Promise<void>;
    /** 重置缓存状态 */
    reset(): void;
    /** 关闭提供者 */
    shutdown(): Promise<void>;
}

// ════════════════════════════════════════════════════════════════
// 单例管理
// ════════════════════════════════════════════════════════════════

let _defaultProvider: SandboxProvider | null = null;
let _initializing = false;
let _initQueue: Array<() => void> = [];

async function waitForInit(): Promise<void> {
    if (!_initializing) return;
    return new Promise((resolve) => {
        _initQueue.push(resolve);
    });
}

/**
 * 获取沙箱提供者单例：
 * 1. 快速路径：已有实例直接返回
 * 2. 冷启动：从 config.sandbox.use 解析类路径 → 实例化 → 缓存
 * 3. 线程安全：防止并发初始化
 */
export async function getSandboxProvider(): Promise<SandboxProvider> {
    // 快速路径
    if (_defaultProvider !== null) {
        return _defaultProvider;
    }

    // 另一个初始化正在进行，等它完成
    if (_initializing) {
        await waitForInit();
        if (_defaultProvider !== null) return _defaultProvider;
    }

    // 冷启动
    _initializing = true;
    try {
        const config = getAppConfig();
        const sandboxUse = config.sandbox?.use;

        if (sandboxUse) {
            try {
                const cls = await resolveClass(sandboxUse);
                const provider = new (cls as new () => SandboxProvider)();
                _defaultProvider = provider;
            } catch {
                // 解析失败，退到错误
                throw new Error(`Failed to create sandbox provider from config: ${sandboxUse}`);
            }
        } else {
            throw new Error("No sandbox provider configured. Set sandbox.use in config.yaml.");
        }
    } finally {
        _initializing = false;
        // 唤醒等待者
        while (_initQueue.length > 0) {
            _initQueue.shift()!();
        }
    }

    return _defaultProvider!;
}

/**
 * 设置沙箱提供者（用于测试或自定义）。
 */
export function setSandboxProvider(provider: SandboxProvider): void {
    _defaultProvider = provider;
}

/**
 * 重置沙箱提供者单例。
 */
export function resetSandboxProvider(): void {
    if (_defaultProvider) {
        _defaultProvider.reset();
    }
    _defaultProvider = null;
}

/**
 * 关闭并重置沙箱提供者。
 */
export async function shutdownSandboxProvider(): Promise<void> {
    if (_defaultProvider) {
        await _defaultProvider.shutdown();
    }
    _defaultProvider = null;
}
