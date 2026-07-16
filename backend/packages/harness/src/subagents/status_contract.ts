/**
 * 子代理状态契约 — 前后端共享的结果格式定义。
 *
 * 对应原项目：backend/packages/harness/deerflow/subagents/status_contract.py
 *
 * 场景：主代理派了一个子代理去做任务。子代理完成后，要把结果告诉主代理和前端。
 *
 * 问题：结果怎么传？直接传一段文字？不行，因为：
 * - 前端需要知道状态（成功还是失败）
 * - 前端需要知道停止原因（是正常完成，还是被强制停止了）
 * - 前端需要知道用了多少 token（算成本）
 * - 前端需要知道用的什么模型（显示给用户）
 *
 * 解决：定义一个"契约"——所有子代理结果都按这个格式传。
 */

/** 状态 */
export const SUBAGENT_STATUS_KEY = "subagent_status";

/** 停止原因 */
export const SUBAGENT_STOP_REASON_KEY = "subagent_stop_reason";

/** 结果摘要 */
export const SUBAGENT_RESULT_BRIEF_KEY = "subagent_result_brief";

/** 结果哈希 */
export const SUBAGENT_RESULT_SHA256_KEY = "subagent_result_sha256";

/** 错误信息 */
export const SUBAGENT_ERROR_KEY = "subagent_error";

/** 用的什么模型 */
export const SUBAGENT_MODEL_NAME_KEY = "subagent_model_name";

/** token 用量 */
export const SUBAGENT_TOKEN_USAGE_KEY = "subagent_token_usage";

// ─── 类型定义 ──────────────────────────────────────────────────

/** 子代理状态值 — 只能是这 5 个之一 */
export type SubagentStatusValue = "completed" | "failed" | "cancelled" | "timed_out" | "polling_timed_out";

/** 子代理停止原因 — 只能是这 3 个之一 */
export type SubagentStopReasonValue = "token_capped" | "turn_capped" | "loop_capped";

// ─── 状态值数组（运行时也能用） ──────────────────────────────────────────────────

/** 所有合法的子代理状态值 */
export const SUBAGENT_STATUS_VALUES: SubagentStatusValue[] = [
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "polling_timed_out",
];


/** 所有合法的子代理停止原因值 */
export const SUBAGENT_STOP_REASON_VALUES: SubagentStopReasonValue[] = [
    "token_capped",
    "turn_capped",
    "loop_capped",
];

// ─── 停止原因标签（人能读的文字） ──────────────────────────────────────────────────

/** 停止原因 → 人能读的标签，用于结果显示 */
export const STOP_REASON_LABELS: Record<SubagentStopReasonValue, string> = {
    token_capped: "token budget",
    turn_capped: "turn budget",
    loop_capped: "repeated tool-call loop",
};

/** 能携带结果的状态（只有 completed 能带结果） */
export const RESULT_BEARING_STATUSES: ReadonlySet<SubagentStatusValue> = new Set(["completed"]);

// ─── 结构化结果接口 ──────────────────────────────────────────────────

/** 子代理结构化结果 */
export interface StructuredSubagentResult {
    status: SubagentStatusValue;
    stop_reason?: SubagentStopReasonValue;
    result_brief?: string;
    result_sha256?: string;
    error?: string;
}

/**
 * 截断文本到最大长度。
 *
 * 原项目 _bound_metadata_text 的逻辑：
 * 如果文本太长，保留前面 2/3 和后面 1/3，中间用 "..." 连接。
 *
 * @param text 原始文本
 * @param cap 最大长度（默认 2000）
 * @returns 截断后的文本
 */
export function boundMetadataText(text: string, cap: number = 2000): string {
    const cleaned = text.trim();
    if (cleaned.length <= cap) {
        return cleaned;
    }
    const marker = "\n...\n";
    const head = Math.floor(cap * 2 / 3);
    const tail = cap - head - marker.length;
    if (tail <= 0) {
        return cleaned.slice(0, cap);
    }
    return cleaned.slice(0, head) + marker + cleaned.slice(-tail);
}
export async function makeSubagentAdditionalKwargs(options:{
    status:SubagentStatusValue //必填
    results?:string | null,
    error?:string | null,
    stop_reason?:SubagentStatusValue | null,
    model_name?:string | null,
    token_usage?:Record<string,unknown> | null
}): Promise<Record<string, unknown>> {
    const { status, results, error, stop_reason, model_name, token_usage } = options;

    const payload: Record<string, unknown> = {};

    // 必填：status
    payload[SUBAGENT_STATUS_KEY] = status;

    // completed 且有 result → 加 result_brief 和 sha256
    if (RESULT_BEARING_STATUSES.has(status) && typeof results === "string" && results.trim()) {
        payload[SUBAGENT_RESULT_BRIEF_KEY] = boundMetadataText(results);
        const { createHash } = await import("node:crypto");
        payload[SUBAGENT_RESULT_SHA256_KEY] = createHash("sha256").update(results).digest("hex");
    }

    // 不是 completed 且有 error → 加 error
    if (status !== "completed" && typeof error === "string" && error.trim()) {
        payload[SUBAGENT_ERROR_KEY] = boundMetadataText(error);
    }

    // 有 stop_reason → 加 stop_reason
    if (stop_reason !== null && stop_reason !== undefined) {
        payload[SUBAGENT_STOP_REASON_KEY] = stop_reason;
    }

    // 有 model_name → 加 model_name
    if (typeof model_name === "string" && model_name.trim()) {
        payload[SUBAGENT_MODEL_NAME_KEY] = model_name.trim();
    }

    // 有 token_usage → 校验后加 token_usage
    const normalizedUsage = normalizeTokenUsage(token_usage);
    if (normalizedUsage !== null) {
        payload[SUBAGENT_TOKEN_USAGE_KEY] = normalizedUsage;
    }

    return payload;
}

// ─── 校验 token 用量 ──────────────────────────────────────────────────

/**
 * 校验 token 用量是否合法。
 *
 * 原项目 normalize_token_usage 的逻辑：
 * - 必须是对象
 * - 必须有 input_tokens, output_tokens, total_tokens 三个字段
 * - 每个字段必须是非负整数（不能是布尔值）
 * - 不合法返回 null
 * 
 */
export function normalizeTokenUsage(value: unknown): Record<string, number> | null {
    if (value === null || value === undefined || typeof value !== "object") {
        return null;
    }

    const obj = value as Record<string, unknown>;
    const normalized: Record<string, number> = {};

    for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
        const amount = obj[key];
        if (typeof amount === "boolean" || typeof amount !== "number" || amount < 0) {
            return null;
        }
        normalized[key] = amount;
    }

    return normalized;
}

// ─── 格式化结果消息 ──────────────────────────────────────────────────

/**
 * 把结果转成人能读的文字，显示给主代理看。
 *
 * 对应原项目 format_subagent_result_message。
 *
 * 输入输出示例：
 * - status="completed", result="分析完成" → "Task Succeeded. Result: 分析完成"
 * - status="failed", error="文件不存在" → "Task failed. Error: 文件不存在"
 * - status="cancelled" → "Task cancelled by user."
 * - status="timed_out" → "Task timed out."
 */
export function formatSubagentResultMessage(
    status: SubagentStatusValue,
    options: {
        result?: string | null;
        error?: string | null;
        stop_reason?: SubagentStopReasonValue | null;
    } = {}
): [string, string | null] {
    const { result, error, stop_reason } = options;
    const resultText = result ?? "";
    const errorText = typeof error === "string" ? error.trim() : "";
    const capped = stop_reason ? STOP_REASON_LABELS[stop_reason] : undefined;

    // completed
    if (status === "completed") {
        if (capped) {
            return [`Task Succeeded (capped: ${capped}). Result: ${resultText}`, null];
        }
        return [`Task Succeeded. Result: ${resultText}`, null];
    }

    // cancelled
    if (status === "cancelled") {
        const detail = errorText || "Task cancelled by user.";
        if (detail === "Task cancelled by user.") {
            return [detail, detail];
        }
        return [`Task cancelled by user. Error: ${detail}`, detail];
    }

    // timed_out
    if (status === "timed_out") {
        const detail = errorText || "Task timed out.";
        if (detail === "Task timed out.") {
            return [detail, detail];
        }
        return [`Task timed out. Error: ${detail}`, detail];
    }

    // polling_timed_out
    if (status === "polling_timed_out") {
        const detail = errorText || "Task polling timed out.";
        return [detail, detail];
    }

    // failed
    const detail = errorText || "Task failed.";
    if (capped) {
        if (detail === "Task failed.") {
            return [`Task failed (capped: ${capped}).`, detail];
        }
        return [`Task failed (capped: ${capped}). Error: ${detail}`, detail];
    }
    if (detail === "Task failed.") {
        return [detail, detail];
    }
    return [`Task failed. Error: ${detail}`, detail];
}

// ─── 读取结果元数据 ──────────────────────────────────────────────────

/**
 * 从 additional_kwargs 里读取子代理结果元数据。
 *
 * 对应原项目 read_subagent_result_metadata。
 *
 * 场景：前端收到一条消息，消息的 additional_kwargs 里有子代理结果。
 * 这个函数把它解析出来。
 *
 * 逻辑：
 * 1. 读 status，检查是否合法
 * 2. 如果是 completed 且有 result_brief，加到结果里
 * 3. 如果不是 completed 且有 error，加到结果里
 * 4. 如果有 stop_reason，加到结果里
 */
export function readSubagentResultMetadata(
    additionalKwargs: Record<string, unknown> | null | undefined
): StructuredSubagentResult | null {
    if (!additionalKwargs) {
        return null;
    }

    // 读 status
    const rawStatus = additionalKwargs[SUBAGENT_STATUS_KEY];
    if (typeof rawStatus !== "string" || !SUBAGENT_STATUS_VALUES.includes(rawStatus as SubagentStatusValue)) {
        return null;
    }

    const status = rawStatus as SubagentStatusValue;
    const payload: StructuredSubagentResult = { status };

    // completed 且有 result_brief → 加 result_brief 和 result_sha256
    if (RESULT_BEARING_STATUSES.has(status)) {
        const rawResult = additionalKwargs[SUBAGENT_RESULT_BRIEF_KEY];
        if (typeof rawResult === "string" && rawResult.trim()) {
            payload.result_brief = boundMetadataText(rawResult);
            const rawHash = additionalKwargs[SUBAGENT_RESULT_SHA256_KEY];
            if (typeof rawHash === "string" && /^[0-9a-f]{64}$/.test(rawHash)) {
                payload.result_sha256 = rawHash;
            }
        }
    }

    // 不是 completed 且有 error → 加 error
    if (status !== "completed") {
        const rawError = additionalKwargs[SUBAGENT_ERROR_KEY];
        if (typeof rawError === "string" && rawError.trim()) {
            payload.error = boundMetadataText(rawError);
        }
    }

    // 有 stop_reason → 加 stop_reason
    const rawStopReason = additionalKwargs[SUBAGENT_STOP_REASON_KEY];
    if (typeof rawStopReason === "string" && SUBAGENT_STOP_REASON_VALUES.includes(rawStopReason as SubagentStopReasonValue)) {
        payload.stop_reason = rawStopReason as SubagentStopReasonValue;
    }

    return payload;
}