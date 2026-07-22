/**
 * LLM 错误处理中间件 — 重试/退避和用户友好的降级消息。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/llm_error_handling_middleware.py
 *
 * 功能：
 *   1. 断路器（Circuit Breaker）：连续失败 N 次后快速拒绝，防止雪崩
 *   2. 错误分类：可重试（瞬时）vs 不可重试（配额/认证/其他）
 *   3. 指数退避重试：逐次增加等待时间
 *   4. 用户友好消息：LLM 挂了不抛原始异常，返回能看懂的文字
 */

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 可重试的 HTTP 状态码 */
const _RETRIABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 服务繁忙关键词 */
const _BUSY_PATTERNS = [
    "server busy", "temporarily unavailable", "try again later",
    "please retry", "please try again", "overloaded",
    "high demand", "rate limit",
    "负载较高", "服务繁忙", "稍后重试", "请稍后重试",
];

/** 配额不足关键词 */
const _QUOTA_PATTERNS = [
    "insufficient_quota", "quota", "billing", "credit",
    "payment", "余额不足", "超出限额", "额度不足", "欠费",
];

/** 认证失败关键词 */
const _AUTH_PATTERNS = [
    "authentication", "unauthorized", "invalid api key",
    "invalid_api_key", "permission", "forbidden",
    "access denied", "无权", "未授权",
];

/** 流中断异常名（需要更具体的用户提示） */
const _STREAM_DROP_EXCEPTIONS = new Set(["StreamChunkTimeoutError"]);

/** 最大重试次数 */
const _RETRY_MAX_ATTEMPTS = 3;
const _RETRY_BASE_DELAY_MS = 1000;
const _RETRY_CAP_DELAY_MS = 8000;

/** 断路器默认参数 */
const _CIRCUIT_FAILURE_THRESHOLD = 5;
const _CIRCUIT_RECOVERY_TIMEOUT_SEC = 60;

/** 异常名 → 最大尝试次数覆盖（StreamChunkTimeoutError 只重试 1 次） */
const _RETRY_BUDGET_OVERRIDES: Record<string, number> = {
    StreamChunkTimeoutError: 2,
};

/** 异常名 → 用户提示内容 */
const _RETRYABLE_EXCEPTION_NAMES = new Set([
    "APITimeoutError",
    "APIConnectionError",
    "InternalServerError",
    "ReadError",
    "RemoteProtocolError",
    "StreamChunkTimeoutError",
]);

// ════════════════════════════════════════════════════════════════════════════════
// 错误信息提取工具
// ════════════════════════════════════════════════════════════════════════════════

function _matchesAny(detail: string, patterns: string[]): boolean {
    const lower = detail.toLowerCase();
    return patterns.some((p) => lower.includes(p));
}

function _extractErrorCode(exc: Error): unknown {
    const excRecord = exc as unknown as Record<string, unknown>;

    // 从异常属性读
    for (const attr of ["code", "error_code"]) {
        const value = excRecord[attr];
        if (value !== undefined && value !== null && value !== "") return value;
    }

    // 从 exc.body?.error 读
    const body = excRecord.body as Record<string, unknown> | undefined;
    if (body) {
        const error = body.error as Record<string, unknown> | undefined;
        if (error) {
            for (const key of ["code", "type"]) {
                const value = error[key];
                if (value !== undefined && value !== null && value !== "") return value;
            }
        }
    }

    return null;
}

function _extractStatusCode(exc: Error): number | null {
    const excRecord = exc as unknown as Record<string, unknown>;

    for (const attr of ["status_code", "status"]) {
        const value = excRecord[attr];
        if (typeof value === "number") return value;
    }

    const response = excRecord.response as Record<string, unknown> | undefined;
    if (response) {
        const status = response.status_code;
        if (typeof status === "number") return status;
    }

    return null;
}

function _extractRetryAfterMs(exc: Error): number | null {
    const excRecord = exc as unknown as Record<string, unknown>;
    const response = excRecord.response as Record<string, unknown> | undefined;
    if (!response) return null;

    const headers = response.headers as Record<string, string> | undefined;
    if (!headers) return null;

    let raw: string | undefined;
    let headerName = "";

    for (const key of ["retry-after-ms", "Retry-After-Ms", "retry-after", "Retry-After"]) {
        headerName = key;
        raw = headers[key];
        if (raw) break;
    }

    if (!raw) return null;

    try {
        const multiplier = headerName.toLowerCase().includes("ms") ? 1 : 1000;
        return Math.max(0, Math.round(parseFloat(raw) * multiplier));
    } catch {
        // 如果是 HTTP 日期格式（Retry-After: Wed, 21 Oct 2025 07:28:00 GMT）
        try {
            const target = new Date(raw).getTime();
            const now = Date.now();
            return Math.max(0, target - now);
        } catch {
            return null;
        }
    }
}

function _extractErrorDetail(exc: Error): string {
    const detail = exc.message?.trim();
    if (detail) return detail;

    const excRecord = exc as unknown as Record<string, unknown>;
    const message = excRecord.message;
    if (typeof message === "string" && message.trim()) return message.trim();

    return exc.constructor.name;
}

// ════════════════════════════════════════════════════════════════════════════════
// 断路器
// ════════════════════════════════════════════════════════════════════════════════

type CircuitState = "closed" | "open" | "half_open";

class CircuitBreaker {
    private _state: CircuitState = "closed";
    private _failureCount = 0;
    private _openUntil = 0;
    private _probeInFlight = false;
    private readonly _failureThreshold: number;
    private readonly _recoveryTimeoutSec: number;

    constructor(failureThreshold?: number, recoveryTimeoutSec?: number) {
        this._failureThreshold = failureThreshold ?? _CIRCUIT_FAILURE_THRESHOLD;
        this._recoveryTimeoutSec = recoveryTimeoutSec ?? _CIRCUIT_RECOVERY_TIMEOUT_SEC;
    }

    /** 检查电路。返回 true = 打开（快速拒绝），false = 允许通过 */
    check(): boolean {
        const now = Date.now() / 1000;

        if (this._state === "open") {
            if (now < this._openUntil) return true;
            this._state = "half_open";
            this._probeInFlight = false;
        }

        if (this._state === "half_open") {
            if (this._probeInFlight) return true;
            this._probeInFlight = true;
            return false;
        }

        return false;
    }

    /** 记录成功 */
    recordSuccess(): void {
        if (this._state !== "closed" || this._failureCount > 0) {
            console.log("Circuit breaker reset (Closed). LLM service recovered.");
        }
        this._failureCount = 0;
        this._openUntil = 0;
        this._state = "closed";
        this._probeInFlight = false;
    }

    /** 记录失败 */
    recordFailure(): void {
        const now = Date.now() / 1000;

        if (this._state === "half_open") {
            this._openUntil = now + this._recoveryTimeoutSec;
            this._state = "open";
            this._probeInFlight = false;
            console.error(
                `Circuit breaker probe failed (Open). Will probe again after ${this._recoveryTimeoutSec}s.`,
            );
            return;
        }

        this._failureCount++;
        if (this._failureCount >= this._failureThreshold) {
            this._openUntil = now + this._recoveryTimeoutSec;
            if (this._state !== "open") {
                this._state = "open";
                this._probeInFlight = false;
                console.error(
                    `Circuit breaker tripped (Open). Threshold reached (${this._failureThreshold}). Will probe after ${this._recoveryTimeoutSec}s.`,
                );
            }
        }
    }

    /** 释放正在进行的探测（不记录失败） */
    releaseProbe(): void {
        if (this._state === "half_open") {
            this._probeInFlight = false;
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 错误分类
// ════════════════════════════════════════════════════════════════════════════════

function _classifyError(exc: Error): [boolean, string] {
    const detail = _extractErrorDetail(exc);
    const errorCode = _extractErrorCode(exc);
    const statusCode = _extractStatusCode(exc);

    // 配额问题 → 不可重试
    if (_matchesAny(detail, _QUOTA_PATTERNS) || _matchesAny(String(errorCode ?? ""), _QUOTA_PATTERNS)) {
        return [false, "quota"];
    }

    // 认证问题 → 不可重试
    if (_matchesAny(detail, _AUTH_PATTERNS)) {
        return [false, "auth"];
    }

    // 已知的可重试异常名
    const excName = exc.constructor.name;
    if (_RETRYABLE_EXCEPTION_NAMES.has(excName)) {
        return [true, "transient"];
    }

    // IndexError 可能是空 generations 列表，属瞬时错误
    if (exc instanceof RangeError || exc instanceof TypeError) {
        // 特殊情况：IndexError 处理
        if (exc.message?.includes("index") || exc.message?.includes("range")) {
            return [true, "transient"];
        }
    }

    // HTTP 状态码检查
    if (statusCode !== null && _RETRIABLE_STATUS_CODES.has(statusCode)) {
        return [true, "transient"];
    }

    // 繁忙关键词
    if (_matchesAny(detail, _BUSY_PATTERNS)) {
        return [true, "busy"];
    }

    return [false, "generic"];
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建消息
// ════════════════════════════════════════════════════════════════════════════════

function _buildRetryMessage(attempt: number, waitMs: number, reason: string): string {
    const seconds = Math.max(1, Math.round(waitMs / 1000));
    const reasonText = reason === "busy" ? "provider is busy" : "provider request failed temporarily";
    return `LLM request retry ${attempt}/${_RETRY_MAX_ATTEMPTS}: ${reasonText}. Retrying in ${seconds}s.`;
}

/**
 * 发射 llm_retry 事件到流写入器。
 * 前端用这个事件显示"正在重试第 X/Y 次"的进度条。
 */
function _emitRetryEvent(attempt: number, waitMs: number, reason: string): void {
    try {
        // 尝试获取全局流写入器（如果有）
        const globalWriter = (globalThis as Record<string, unknown>).__stream_writer;
        if (typeof globalWriter === "function") {
            globalWriter({
                type: "llm_retry",
                attempt,
                max_attempts: _RETRY_MAX_ATTEMPTS,
                wait_ms: waitMs,
                reason,
                message: _buildRetryMessage(attempt, waitMs, reason),
            });
        }
    } catch {
        // 获取流写入器失败，只是重试不影响主流程
    }
}

function _buildUserMessage(exc: Error, reason: string): string {
    if (reason === "quota") {
        return "The configured LLM provider rejected the request because the account is out of quota, billing is unavailable, or usage is restricted. Please fix the provider account and try again.";
    }
    if (reason === "auth") {
        return "The configured LLM provider rejected the request because authentication or access is invalid. Please check the provider credentials and try again.";
    }
    if (reason === "busy" || reason === "transient") {
        if (_STREAM_DROP_EXCEPTIONS.has(exc.constructor.name)) {
            return (
                "The model's streaming response was interrupted before it could finish. " +
                "This usually happens when a single response or tool call is very large — " +
                "please ask the assistant to split the work into smaller steps, or shorten " +
                "the requested output, and try again."
            );
        }
        return "The configured LLM provider is temporarily unavailable after multiple retries. Please wait a moment and continue the conversation.";
    }
    return `LLM request failed: ${_extractErrorDetail(exc)}`;
}

function _buildErrorFallbackMessage(
    content: string,
    errorType: string,
    reason: string,
    detail: string,
): Record<string, unknown> {
    return {
        type: "ai",
        content,
        additional_kwargs: {
            deerflow_error_fallback: true,
            error_type: errorType,
            error_reason: reason,
            error_detail: detail,
        },
    };
}

function _buildCircuitBreakerMessage(): Record<string, unknown> {
    return _buildErrorFallbackMessage(
        "The configured LLM provider is currently unavailable due to continuous failures. Circuit breaker is engaged to protect the system. Please wait a moment before trying again.",
        "CircuitBreakerOpen",
        "circuit_open",
        "LLM circuit breaker is open",
    );
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * LLM 错误处理中间件 — 重试/退避。
 *
 * 重试逻辑：
 *   1. 检查断路器 → 如果打开，快速拒绝
 *   2. 尝试调用 LLM
 *   3. 成功 → 记录成功，返回结果
 *   4. 失败 → 分类错误
 *      - 可重试且未超次数 → 指数退避后重试
 *      - 不可重试 → 返回用户友好消息
 *
 * @param handler LLM 调用函数
 * @param appConfig 可选 AppConfig（断路器参数）
 * @returns LLM 响应或错误消息
 */
export function wrapLlmCallWithRetry(
    handler: () => Record<string, unknown>,
    appConfig?: unknown,
): Record<string, unknown> {
    // 断路器单例
    const breaker = _getCircuitBreaker(appConfig);

    if (breaker.check()) {
        return _buildCircuitBreakerMessage();
    }

    let attempt = 1;
    while (true) {
        try {
            const response = handler();
            breaker.recordSuccess();
            return response;
        } catch (error) {
            const exc = error as Error;

            // 保留 LangGraph 控制流信号
            if (exc.constructor.name === "GraphBubbleUp") {
                breaker.releaseProbe();
                throw error;
            }

            const [retriable, reason] = _classifyError(exc);
            const maxAttempts = _maxAttemptsFor(exc);

            if (retriable && attempt < maxAttempts) {
                const waitMs = _buildRetryDelayMs(attempt, exc);
                _emitRetryEvent(attempt, waitMs, reason);
                attempt++;
                // 同步等待（while 循环阻塞，因为没有 setTimeout 可用）
                const start = Date.now();
                while (Date.now() - start < waitMs) {
                    // busy wait
                }
                continue;
            }

            if (retriable) {
                breaker.recordFailure();
            } else {
                breaker.releaseProbe();
            }
            return _buildUserFallbackMessage(exc, reason);
        }
    }
}

/**
 * LLM 错误处理中间件 — 异步重试/退避。
 */
export async function awrapLlmCallWithRetry(
    handler: () => Promise<Record<string, unknown>>,
    appConfig?: unknown,
): Promise<Record<string, unknown>> {
    const breaker = _getCircuitBreaker(appConfig);

    if (breaker.check()) {
        return _buildCircuitBreakerMessage();
    }

    let attempt = 1;
    while (true) {
        try {
            const response = await handler();
            breaker.recordSuccess();
            return response;
        } catch (error) {
            const exc = error as Error;

            if (exc.constructor.name === "GraphBubbleUp") {
                breaker.releaseProbe();
                throw error;
            }

            const [retriable, reason] = _classifyError(exc);
            const maxAttempts = _maxAttemptsFor(exc);

            if (retriable && attempt < maxAttempts) {
                const waitMs = _buildRetryDelayMs(attempt, exc);
                _emitRetryEvent(attempt, waitMs, reason);
                attempt++;
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                continue;
            }

            if (retriable) {
                breaker.recordFailure();
            } else {
                breaker.releaseProbe();
            }
            return _buildUserFallbackMessage(exc, reason);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 内部辅助
// ════════════════════════════════════════════════════════════════════════════════

let _circuitBreaker: CircuitBreaker | null = null;

function _getCircuitBreaker(appConfig?: unknown): CircuitBreaker {
    if (_circuitBreaker) return _circuitBreaker;

    let threshold = _CIRCUIT_FAILURE_THRESHOLD;
    let timeout = _CIRCUIT_RECOVERY_TIMEOUT_SEC;

    if (appConfig) {
        const config = appConfig as Record<string, unknown>;
        const circuitBreaker = config.circuit_breaker as Record<string, unknown> | undefined;
        if (circuitBreaker) {
            if (typeof circuitBreaker.failure_threshold === "number") {
                threshold = circuitBreaker.failure_threshold;
            }
            if (typeof circuitBreaker.recovery_timeout_sec === "number") {
                timeout = circuitBreaker.recovery_timeout_sec;
            }
        }
    }

    _circuitBreaker = new CircuitBreaker(threshold, timeout);
    return _circuitBreaker;
}

function _maxAttemptsFor(exc: Error): number {
    const override = _RETRY_BUDGET_OVERRIDES[exc.constructor.name];
    if (override === undefined) return _RETRY_MAX_ATTEMPTS;
    return Math.min(override, _RETRY_MAX_ATTEMPTS);
}

function _buildRetryDelayMs(attempt: number, exc: Error): number {
    const retryAfter = _extractRetryAfterMs(exc);
    if (retryAfter !== null) return retryAfter;

    const backoff = _RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(backoff, _RETRY_CAP_DELAY_MS);
}

function _buildUserFallbackMessage(exc: Error, reason: string): Record<string, unknown> {
    return _buildErrorFallbackMessage(
        _buildUserMessage(exc, reason),
        exc.constructor.name,
        reason,
        _extractErrorDetail(exc),
    );
}
