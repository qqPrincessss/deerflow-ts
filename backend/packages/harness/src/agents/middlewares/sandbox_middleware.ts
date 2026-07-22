/**
 * 沙箱中间件 — 管理沙箱生命周期。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/sandbox_middleware.py
 *
 * 沙箱生命周期：
 *   lazy_init=true（默认）：首次工具调用时获取沙箱
 *   lazy_init=false：首次 Agent 调用时获取沙箱
 *   沙箱在线程内复用，跨多轮对话
 *   沙箱在 Agent 调用后释放
 *
 * 两套接口（同步/异步）支持两种运行模式。
 */

import { getSandboxProvider } from "../../sandbox/sandbox_provider.js";
import { resolveRuntimeUserId } from "../../runtime/user_context.js";

// ════════════════════════════════════════════════════════════════════════════════
// 沙箱获取/释放
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 获取沙箱（异步）。
 */
async function _acquireSandboxAsync(threadId: string, userId: string): Promise<string> {
    const provider = await getSandboxProvider();
    return provider.acquire(threadId, userId);
}

/**
 * 释放沙箱（异步）。
 */
async function _releaseSandboxAsync(sandboxId: string): Promise<void> {
    const provider = await getSandboxProvider();
    await provider.release(sandboxId);
}

// ════════════════════════════════════════════════════════════════════════════════
// 状态读取
// ════════════════════════════════════════════════════════════════════════════════

function _readSandboxIdFromState(state: Record<string, unknown> | null | undefined): string | null {
    if (!state) return null;
    const sandboxState = state.sandbox as Record<string, unknown> | undefined;
    if (!sandboxState) return null;
    const sandboxId = sandboxState.sandbox_id;
    return typeof sandboxId === "string" ? sandboxId : null;
}

function _readSandboxIdFromRuntimeState(runtime: Record<string, unknown> | null | undefined): string | null {
    if (!runtime) return null;
    const state = runtime.state as Record<string, unknown> | undefined;
    return _readSandboxIdFromState(state ?? null);
}

// ════════════════════════════════════════════════════════════════════════════════
// 入口：Agent 运行前
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Agent 运行前 — 获取沙箱（同步模式）。
 *
 * lazy_init=true：跳过（延迟到首次工具调用）
 * lazy_init=false：立即获取沙箱
 */
export function beforeAgentSandbox(options: {
    state?: Record<string, unknown> | null;
    runtime?: Record<string, unknown> | null;
    lazyInit?: boolean;
}): Record<string, unknown> | null {
    const { state, runtime, lazyInit = true } = options;

    if (lazyInit) return null;
    const existingSandbox = state ? _readSandboxIdFromState(state) : null;
    if (existingSandbox) return null;

    const ctx = runtime?.context as Record<string, unknown> | undefined;
    const threadId = ctx?.thread_id as string | undefined;
    if (!threadId) return null;

    const userId = resolveRuntimeUserId(runtime ?? {});

    // 同步模式下启动异步获取，同步返回 promise 的 then
    _acquireSandboxAsync(threadId, userId).then((sandboxId) => {
        return { sandbox: { sandbox_id: sandboxId } };
    });

    return null;
}

/**
 * Agent 运行前 — 获取沙箱（异步模式）。
 */
export async function abeforeAgentSandbox(options: {
    state?: Record<string, unknown> | null;
    runtime?: Record<string, unknown> | null;
    lazyInit?: boolean;
}): Promise<Record<string, unknown> | null> {
    const { state, runtime, lazyInit = true } = options;

    if (lazyInit) return null;
    const existingSandbox = state ? _readSandboxIdFromState(state) : null;
    if (existingSandbox) return null;

    const ctx = runtime?.context as Record<string, unknown> | undefined;
    const threadId = ctx?.thread_id as string | undefined;
    if (!threadId) return null;

    const userId = resolveRuntimeUserId(runtime ?? {});
    const sandboxId = await _acquireSandboxAsync(threadId, userId);

    return { sandbox: { sandbox_id: sandboxId } };
}

// ════════════════════════════════════════════════════════════════════════════════
// 入口：工具调用包裹
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 工具调用包裹 — 检测延迟初始化，将 sandbox_id 持久化到 graph state（同步）。
 *
 * 在工具执行后调用。
 * 如果工具执行前没有 sandbox（prev=null），执行后有了（curr=id），
 * 说明 ensure_sandbox_initialized 在工具内部创建了沙箱。
 * 把 sandbox_id 附加到工具结果中，让 reducer 合并到 graph state。
 */
export function wrapToolCallWithSandbox(
    prevState: Record<string, unknown> | null | undefined,
    toolResult: Record<string, unknown>,
    runtime: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
    const prevSandboxId = _readSandboxIdFromState(prevState ?? null);
    if (prevSandboxId !== null) return toolResult;

    const currSandboxId = _readSandboxIdFromRuntimeState(runtime);
    if (!currSandboxId) return toolResult;

    return {
        ...toolResult,
        sandbox: { sandbox_id: currSandboxId },
    };
}

/**
 * 工具调用包裹 — 异步版本。
 */
export async function awrapToolCallWithSandbox(
    prevState: Record<string, unknown> | null | undefined,
    toolResultPromise: Promise<Record<string, unknown>> | Record<string, unknown>,
    runtime: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
    const toolResult = await toolResultPromise;
    return wrapToolCallWithSandbox(prevState, toolResult, runtime);
}

// ════════════════════════════════════════════════════════════════════════════════
// 入口：Agent 运行后（释放沙箱）
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Agent 运行后 — 释放沙箱（同步）。
 *
 * 从 state 或 runtime.context 中找到 sandbox_id 并释放。
 */
export function afterAgentSandbox(
    state: Record<string, unknown> | null | undefined,
    runtime: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
    let sandboxId = _readSandboxIdFromState(state ?? null);

    if (!sandboxId) {
        const ctx = runtime?.context as Record<string, unknown> | undefined;
        sandboxId = ctx?.sandbox_id as string | undefined ?? null;
    }

    if (sandboxId) {
        // 同步模式下异步释放
        _releaseSandboxAsync(sandboxId).catch(() => {});
    }

    return null;
}

/**
 * Agent 运行后 — 释放沙箱（异步）。
 */
export async function aafterAgentSandbox(
    state: Record<string, unknown> | null | undefined,
    runtime: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown> | null> {
    let sandboxId = _readSandboxIdFromState(state ?? null);

    if (!sandboxId) {
        const ctx = runtime?.context as Record<string, unknown> | undefined;
        sandboxId = ctx?.sandbox_id as string | undefined ?? null;
    }

    if (sandboxId) {
        await _releaseSandboxAsync(sandboxId);
    }

    return null;
}
