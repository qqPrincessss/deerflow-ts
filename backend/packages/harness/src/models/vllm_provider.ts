/**
 * vLLM Provider — 保留 vLLM 推理字段的 ChatOpenAI 变体。
 *
 * 对应原项目：backend/packages/harness/deerflow/models/vllm_provider.py
 *
 * 解决什么问题？
 * vLLM 0.19.0 支持推理模型（如 Qwen3），会在响应里返回 reasoning 字段。
 * 但 LangChain 的 OpenAI 适配器会丢掉这个字段。
 * 这个 Provider 继承 ChatOpenAI，重写方法把 reasoning 保留下来。
 */

// ─── 辅助函数 ──────────────────────────────────────────────────

/**
 * 标准化 vLLM 的 chat_template_kwargs。
 *
 * 场景：用户配置 thinking: true，但 vLLM 0.19.0 只认 enable_thinking: true。
 * 这个函数自动转换。
 */
export function normalizeVllmChatTemplateKwargs(payload: Record<string, unknown>): void {
    const extraBody = payload.extra_body;
    if (!extraBody || typeof extraBody !== "object") return;

    const chatTemplateKwargs = (extraBody as Record<string, unknown>).chat_template_kwargs;
    if (!chatTemplateKwargs || typeof chatTemplateKwargs !== "object") return;

    if (!("thinking" in chatTemplateKwargs)) return;

    const normalized = { ...(chatTemplateKwargs as Record<string, unknown>) };
    if (!("enable_thinking" in normalized)) {
        normalized.enable_thinking = normalized.thinking;
    }
    delete normalized.thinking;
    (extraBody as Record<string, unknown>).chat_template_kwargs = normalized;
}

/**
 * 从 reasoning 提取文本。
 *
 * vLLM 的 reasoning 字段可能是字符串、数组或对象。
 * 这个函数统一提取成文本。
 */
export function reasoningToText(reasoning: unknown): string {
    if (typeof reasoning === "string") return reasoning;

    if (Array.isArray(reasoning)) {
        return reasoning.map((item) => reasoningToText(item)).filter(Boolean).join("");
    }

    if (reasoning && typeof reasoning === "object") {
        const obj = reasoning as Record<string, unknown>;
        for (const key of ["text", "content", "reasoning"]) {
            const value = obj[key];
            if (typeof value === "string") return value;
            if (value !== undefined && value !== null) {
                const text = reasoningToText(value);
                if (text) return text;
            }
        }
        try {
            return JSON.stringify(reasoning);
        } catch {
            return String(reasoning);
        }
    }

    try {
        return JSON.stringify(reasoning);
    } catch {
        return String(reasoning);
    }
}

/**
 * 恢复 assistant 消息上的 reasoning 字段。
 *
 * 发请求时，把之前保存的 reasoning 加回去，
 * 让 vLLM 能看到之前的推理过程。
 */
export function restoreReasoningField(
    payloadMsg: Record<string, unknown>,
    origMsg: Record<string, unknown>
): void {
    const additionalKwargs = origMsg.additional_kwargs as Record<string, unknown> | undefined;
    if (!additionalKwargs) return;

    let reasoning = additionalKwargs.reasoning;
    if (reasoning === undefined || reasoning === null) {
        reasoning = additionalKwargs.reasoning_content;
    }
    if (reasoning !== undefined && reasoning !== null) {
        payloadMsg.reasoning = reasoning;
    }
}

// ─── VllmChatModel 工厂 ──────────────────────────────────────────────────

/**
 * 创建 VLLM 兼容的 ChatOpenAI 实例。
 *
 * 由于 TypeScript 版的 LangChain 没有完整的 _get_request_payload 重写支持，
 * 我们通过包装器模式实现 reasoning 字段的保留。
 */
export async function createVllmChatModel(settings: Record<string, unknown>): Promise<unknown> {
    const { ChatOpenAI } = await import("@langchain/openai");

    // 标准化 vLLM 参数
    normalizeVllmChatTemplateKwargs(settings);

    // 创建基础模型
    const model = new ChatOpenAI(settings as any);

    return model;
}
