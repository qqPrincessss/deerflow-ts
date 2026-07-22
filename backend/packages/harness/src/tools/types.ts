/**
 * 工具运行时类型。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/types.py
 *
 * 所有 DeerFlow 工具使用的统一运行时类型。
 */

import { type ThreadState } from "../agents/thread_state.js";

/** 工具运行时的上下文类型 */
export interface RuntimeContext {
    configurable?: Record<string, unknown>;
    [key: string]: unknown;
}

/** 工具运行时类型 */
export type Runtime = {
    context: RuntimeContext;
    state?: ThreadState;
};
