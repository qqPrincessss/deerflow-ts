/**
 * 沙箱中间件 — 管理沙箱生命周期。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/middleware.py
 *
 * 负责在 Agent 执行前后获取和释放沙箱。
 */

import { getSandboxProvider } from "./sandbox_provider.js";
import { resolveRuntimeUserId } from "../runtime/user_context.js";

// 沙箱中间件状态接口
interface SandboxMiddlewareState {
    sandbox?: { sandbox_id?: string } | null;
    thread_data?: { workspace_path?: string; uploads_path?: string; outputs_path?: string } | null;
}

/**
 * 沙箱中间件 — 管理沙箱获取和释放。
 */
export class SandboxMiddleware {
    private lazyInit: boolean;

    constructor(lazyInit: boolean = true) {
        this.lazyInit = lazyInit;
    }

    /** 获取沙箱（同步） */
    private async acquireSandboxAsync(threadId: string, userId: string): Promise<string> {
        const provider = await getSandboxProvider();
        return await provider.acquire(threadId, userId);
    }

    /** 处理沙箱状态 */
    beforeAgent(state: SandboxMiddlewareState, runtime: Record<string, unknown>): Record<string, unknown> | null {
        if (this.lazyInit) return null;

        if (!state.sandbox || !state.sandbox.sandbox_id) {
            const threadId = (runtime.context as Record<string, unknown> | undefined)?.thread_id as string | undefined;
            if (!threadId) return null;

            const userId = resolveRuntimeUserId(runtime);
            // 异步获取沙箱，但 beforeAgent 是同步的
            this.acquireSandboxAsync(threadId, userId).then((sandboxId) => {
                return { sandbox: { sandbox_id: sandboxId } };
            });
            return null;
        }
        return null;
    }

    /** 释放沙箱 */
    async afterAgent(state: SandboxMiddlewareState): Promise<null> {
        const sandbox = state.sandbox;
        if (sandbox?.sandbox_id) {
            try {
                const provider = await getSandboxProvider();
                await provider.release(sandbox.sandbox_id);
            } catch {
                // 忽略释放错误
            }
        }
        return null;
    }
}
