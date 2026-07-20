/**
 * 用户上下文 — 管理当前请求的用户身份。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/user_context.py
 *
 * 解决什么问题？
 * 每个用户有自己的记忆、线程、技能。系统要知道"当前是谁在用"。
 * 用 AsyncLocalStorage 存储当前用户，认证中间件设置它，业务代码读取它。
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ─── 类型定义 ──────────────────────────────────────────────────

/**
 * 当前用户的结构。
 * 任何有 id: string 的对象都算 CurrentUser。
 */
export interface CurrentUser {
    id: string;
}

// ─── 存储 ──────────────────────────────────────────────────

/**
 * 存储当前用户的全局变量。
 * 每个 HTTP 请求有独立的存储，互不干扰。
 */
const userStorage = new AsyncLocalStorage<CurrentUser | null>();

/** 默认用户 ID（没有用户时使用） */
export const DEFAULT_USER_ID = "default";

/** AUTO 哨兵值（表示"从上下文自动获取"） */
export const AUTO = Symbol("AUTO");

// ─── 核心函数 ──────────────────────────────────────────────────

/**
 * 设置当前用户（认证中间件调用）。
 */
export function setCurrentUser(user: CurrentUser): void {
    userStorage.enterWith(user);
}

/**
 * 获取当前用户（可能为 null）。
 * 安全调用，不会报错。
 */
export function getCurrentUser(): CurrentUser | null {
    return userStorage.getStore() ?? null;
}

/**
 * 获取当前用户（必须有，否则报错）。
 * 用于必须在认证上下文中调用的代码。
 */
export function requireCurrentUser(): CurrentUser {
    const user = getCurrentUser();
    if (!user) {
        throw new Error("repository accessed without user context");
    }
    return user;
}

/**
 * 获取用户 ID（没有用户返回 "default"）。
 * 用于文件系统路径解析，永远不报错。
 */
export function getEffectiveUserId(): string {
    const user = getCurrentUser();
    return user?.id ?? DEFAULT_USER_ID;
}

/**
 * 从运行时上下文获取用户 ID。
 *
 * 解析顺序（最权威的优先）：
 * 1. runtime.context["user_id"] — 网关设置的
 * 2. AsyncLocalStorage 里的当前用户
 * 3. DEFAULT_USER_ID — 兜底
 */
export function resolveRuntimeUserId(runtime: unknown): string {
    const context = (runtime as Record<string, unknown>)?.context;
    if (context && typeof context === "object") {
        const userId = (context as Record<string, unknown>).user_id;
        if (userId) return String(userId);
    }
    return getEffectiveUserId();
}

/**
 * 解析用户 ID（三种语义）。
 *
 * - AUTO：从上下文自动获取，没有就报错
 * - string：直接使用
 * - null：不过滤（用于迁移脚本）
 */
export function resolveUserId(
    value: string | null | typeof AUTO,
    methodName: string = "repository method"
): string | null {
    if (value === AUTO) {
        const user = getCurrentUser();
        if (!user) {
            throw new Error(
                `${methodName} called with user_id=AUTO but no user context; ` +
                `pass an explicit user_id or set the context via auth middleware.`
            );
        }
        return user.id;
    }
    return value;
}
