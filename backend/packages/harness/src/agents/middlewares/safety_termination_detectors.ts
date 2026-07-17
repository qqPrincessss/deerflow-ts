/**
 * 安全终止检测器 — 检测 LLM 提供商的安全终止信号。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/safety_termination_detectors.py
 *
 * 不同 LLM 提供商用不同方式表示"因为安全原因停止了响应"：
 * - OpenAI: finish_reason = "content_filter"
 * - Anthropic: stop_reason = "refusal"
 * - Gemini: finish_reason = "SAFETY" / "BLOCKLIST" 等
 *
 * 这个模块定义了检测器接口和 3 个内置检测器。
 */

// ─── 类型定义 ──────────────────────────────────────────────────

/**
 * 检测到的安全终止信号。
 */
export interface SafetyTermination {
    /** 检测器名 */
    detector: string;
    /** 携带信号的字段名（如 finish_reason） */
    reason_field: string;
    /** 字段值（如 content_filter） */
    reason_value: string;
    /** 提供商特定的额外元数据 */
    extras?: Record<string, unknown>;
}

/**
 * 检测器接口。
 */
export interface SafetyTerminationDetector {
    /** 检测器名 */
    name: string;
    /** 检测消息是否是安全终止 */
    detect(message: Record<string, unknown>): SafetyTermination | null;
}

// ─── 工具函数 ──────────────────────────────────────────────────

/**
 * 从消息的 response_metadata 或 additional_kwargs 中读取字段值。
 *
 * LangChain 的不同提供商把停止信号放在不同的地方，
 * 这个函数两个都检查。
 */
function getMetadataValue(message: Record<string, unknown>, fieldName: string): string | null {
    for (const containerName of ["response_metadata", "additional_kwargs"]) {
        const container = message[containerName];
        if (!container || typeof container !== "object") continue;
        const value = (container as Record<string, unknown>)[fieldName];
        if (typeof value === "string" && value) return value;
    }
    return null;
}

// ─── 内置检测器 ──────────────────────────────────────────────────

/**
 * OpenAI 兼容的内容过滤检测器。
 *
 * 覆盖 OpenAI、Azure OpenAI、DeepSeek、Mistral、vLLM、Qwen 等。
 */
export class OpenAICompatibleContentFilterDetector implements SafetyTerminationDetector {
    name = "openai_compatible_content_filter";
    private finishReasons: Set<string>;

    constructor(finishReasons?: string[]) {
        const configured = finishReasons ?? ["content_filter"];
        this.finishReasons = new Set(configured.map((r) => r.toLowerCase()));
    }

    detect(message: Record<string, unknown>): SafetyTermination | null {
        const value = getMetadataValue(message, "finish_reason");
        if (!value || !this.finishReasons.has(value.toLowerCase())) return null;

        const extras: Record<string, unknown> = {};
        const responseMetadata = message.response_metadata as Record<string, unknown> | undefined;
        if (responseMetadata?.content_filter_results) {
            extras.content_filter_results = responseMetadata.content_filter_results;
        }

        return {
            detector: this.name,
            reason_field: "finish_reason",
            reason_value: value,
            extras,
        };
    }
}

/**
 * Anthropic 拒绝检测器。
 *
 * Anthropic 用 stop_reason = "refusal" 表示安全拒绝。
 */
export class AnthropicRefusalDetector implements SafetyTerminationDetector {
    name = "anthropic_refusal";
    private stopReasons: Set<string>;

    constructor(stopReasons?: string[]) {
        const configured = stopReasons ?? ["refusal"];
        this.stopReasons = new Set(configured.map((r) => r.toLowerCase()));
    }

    detect(message: Record<string, unknown>): SafetyTermination | null {
        const value = getMetadataValue(message, "stop_reason");
        if (!value || !this.stopReasons.has(value.toLowerCase())) return null;

        return {
            detector: this.name,
            reason_field: "stop_reason",
            reason_value: value,
        };
    }
}

/**
 * Gemini 安全检测器。
 *
 * Gemini 用 finish_reason = "SAFETY" / "BLOCKLIST" 等表示安全过滤。
 */
export class GeminiSafetyDetector implements SafetyTerminationDetector {
    name = "gemini_safety";

    private static DEFAULT_FINISH_REASONS = [
        "SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION",
        "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
    ];

    private finishReasons: Set<string>;

    constructor(finishReasons?: string[]) {
        const configured = finishReasons ?? GeminiSafetyDetector.DEFAULT_FINISH_REASONS;
        this.finishReasons = new Set(configured.map((r) => r.toUpperCase()));
    }

    detect(message: Record<string, unknown>): SafetyTermination | null {
        const value = getMetadataValue(message, "finish_reason");
        if (!value || !this.finishReasons.has(value.toUpperCase())) return null;

        const extras: Record<string, unknown> = {};
        const responseMetadata = message.response_metadata as Record<string, unknown> | undefined;
        if (responseMetadata?.safety_ratings) {
            extras.safety_ratings = responseMetadata.safety_ratings;
        }

        return {
            detector: this.name,
            reason_field: "finish_reason",
            reason_value: value,
            extras,
        };
    }
}

// ─── 默认检测器 ──────────────────────────────────────────────────

/**
 * 内置默认检测器集合。
 */
export function defaultDetectors(): SafetyTerminationDetector[] {
    return [
        new OpenAICompatibleContentFilterDetector(),
        new AnthropicRefusalDetector(),
        new GeminiSafetyDetector(),
    ];
}
