/**
 * 记忆更新队列 — 带去抖机制的队列。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/memory/queue.py
 *
 * 作用：收集对话上下文，等待去抖时间后批量处理记忆更新。
 */

import { getAppConfig } from "../../config/app_config.js";

// ════════════════════════════════════════════════════════════════
// 对话上下文
// ════════════════════════════════════════════════════════════════

interface ConversationContext {
    threadId: string;
    messages: Array<{ type: string; content: unknown }>;
    timestamp: number;
    agentName?: string;
    userId?: string;
    deerflowTraceId?: string;
    correctionDetected: boolean;
    reinforcementDetected: boolean;
}

// ════════════════════════════════════════════════════════════════
// MemoryUpdateQueue 类
// ════════════════════════════════════════════════════════════════

export class MemoryUpdateQueue {
    private queue: ConversationContext[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private processing = false;
    private reprocessPending = false;

    /** 生成去抖标识 */
    private static _queueKey(threadId: string, userId?: string, agentName?: string): string {
        return `${threadId}:${userId || ""}:${agentName || ""}`;
    }

    /**
     * 添加对话到队列（去抖后处理）。
     */
    add(
        threadId: string,
        messages: Array<{ type: string; content: unknown }>,
        agentName?: string,
        userId?: string,
        deerflowTraceId?: string,
        correctionDetected: boolean = false,
        reinforcementDetected: boolean = false
    ): void {
        const config = getAppConfig();
        if (!config.memory?.enabled) return;

        this._enqueueLocked(threadId, messages, agentName, userId, deerflowTraceId, correctionDetected, reinforcementDetected);
        this._resetTimer();
        console.log(`Memory update queued for thread ${threadId}, queue size: ${this.queue.length}`);
    }

    /**
     * 添加对话并立即处理。
     */
    addNowait(
        threadId: string,
        messages: Array<{ type: string; content: unknown }>,
        agentName?: string,
        userId?: string,
        deerflowTraceId?: string,
        correctionDetected: boolean = false,
        reinforcementDetected: boolean = false
    ): void {
        const config = getAppConfig();
        if (!config.memory?.enabled) return;

        this._enqueueLocked(threadId, messages, agentName, userId, deerflowTraceId, correctionDetected, reinforcementDetected);
        this._scheduleTimer(0);
        console.log(`Memory update queued for immediate processing on thread ${threadId}, queue size: ${this.queue.length}`);
    }

    /** 内部入队（去重 + 合并信号） */
    private _enqueueLocked(
        threadId: string,
        messages: Array<{ type: string; content: unknown }>,
        agentName?: string,
        userId?: string,
        deerflowTraceId?: string,
        correctionDetected: boolean = false,
        reinforcementDetected: boolean = false
    ): void {
        const key = MemoryUpdateQueue._queueKey(threadId, userId, agentName);
        const existing = this.queue.find(
            (ctx) => MemoryUpdateQueue._queueKey(ctx.threadId, ctx.userId, ctx.agentName) === key
        );

        const mergedCorrection = correctionDetected || (existing?.correctionDetected ?? false);
        const mergedReinforcement = reinforcementDetected || (existing?.reinforcementDetected ?? false);

        // 移除旧条目
        this.queue = this.queue.filter(
            (ctx) => MemoryUpdateQueue._queueKey(ctx.threadId, ctx.userId, ctx.agentName) !== key
        );

        this.queue.push({
            threadId,
            messages,
            agentName,
            userId,
            deerflowTraceId,
            timestamp: Date.now(),
            correctionDetected: mergedCorrection,
            reinforcementDetected: mergedReinforcement,
        });
    }

    /** 重置去抖定时器 */
    private _resetTimer(): void {
        const config = getAppConfig();
        const delaySeconds = config.memory?.debounce_seconds ?? 30;
        this._scheduleTimer(delaySeconds);
    }

    /** 设定定时器 */
    private _scheduleTimer(delaySeconds: number): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (delaySeconds <= 0) {
            // 立即执行，但用 setTimeout 0 让出当前事件循环
            this.timer = setTimeout(() => this._processQueue(), 0);
        } else {
            this.timer = setTimeout(() => this._processQueue(), delaySeconds * 1000);
        }
    }

    /** 处理队列 */
    private async _processQueue(): Promise<void> {
        if (this.processing) {
            this.reprocessPending = true;
            return;
        }

        if (this.queue.length === 0) return;

        const contextsToProcess = [...this.queue];
        this.queue = [];
        this.timer = null;
        this.processing = true;

        try {
            console.log(`Processing ${contextsToProcess.length} queued memory updates`);

            for (let i = 0; i < contextsToProcess.length; i++) {
                const ctx = contextsToProcess[i];
                try {
                    const { MemoryUpdater } = await import("./updater.js");
                    const updater = new MemoryUpdater();
                    console.log(`Updating memory for thread ${ctx.threadId}`);
                    const success = await updater.update(ctx.messages, ctx.agentName, ctx.userId);
                    if (success) {
                        console.log(`Memory updated successfully for thread ${ctx.threadId}`);
                    } else {
                        console.warn(`Memory update skipped/failed for thread ${ctx.threadId}`);
                    }
                } catch (err) {
                    console.error(`Error updating memory for thread ${ctx.threadId}:`, err);
                }

                // 多个更新之间小延迟，避免限流
                if (i < contextsToProcess.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
            }
        } finally {
            this.processing = false;
            if (this.reprocessPending) {
                this.reprocessPending = false;
                if (this.queue.length > 0) {
                    this._scheduleTimer(0);
                }
            }
        }
    }

    /** 强制立即处理 */
    flush(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this._processQueue();
    }

    /** 在后台立即开始处理 */
    flushNowait(): void {
        this._scheduleTimer(0);
    }

    /** 清空队列 */
    clear(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.queue = [];
        this.processing = false;
        this.reprocessPending = false;
    }

    /** 待处理数量 */
    get pendingCount(): number {
        return this.queue.length;
    }

    /** 是否正在处理 */
    get isProcessing(): boolean {
        return this.processing;
    }
}

// ════════════════════════════════════════════════════════════════
// 全局单例
// ════════════════════════════════════════════════════════════════

let _memoryQueue: MemoryUpdateQueue | null = null;

export function getMemoryQueue(): MemoryUpdateQueue {
    if (_memoryQueue === null) {
        _memoryQueue = new MemoryUpdateQueue();
    }
    return _memoryQueue;
}

export function resetMemoryQueue(): void {
    if (_memoryQueue !== null) {
        _memoryQueue.clear();
    }
    _memoryQueue = null;
}
