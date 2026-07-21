/**
 * Claude Provider — 支持 OAuth Bearer 认证的 ChatAnthropic 变体。
 *
 * 对应原项目：backend/packages/harness/deerflow/models/claude_provider.py
 *
 * 解决什么问题？
 * 用户订阅了 Claude Code（每月 $100），想用这个额度跑 DeerFlow。
 * Claude Code 的 OAuth token 和普通 API key 认证方式不一样：
 * - API key: x-api-key: sk-ant-xxx
 * - OAuth token: Authorization: Bearer sk-ant-oat-xxx
 */

// ─── 常量 ──────────────────────────────────────────────────

/** 最大重试次数 */
const MAX_RETRIES = 3;

/** thinking 预算占 max_tokens 的比例 */
const THINKING_BUDGET_RATIO = 0.8;

/** OAuth 计费头（Anthropic 要求的） */
const DEFAULT_BILLING_HEADER = "x-anthropic-billing-header: cc_version=2.1.85.351; cc_entrypoint=cli; cch=6c6d5;";

// ─── 工具函数 ──────────────────────────────────────────────────

/**
 * 检测是否是 OAuth token。
 * OAuth token 以 sk-ant-oat 开头。
 */
export function isOAuthToken(token: string): boolean {
    return token.startsWith("sk-ant-oat");
}

/**
 * 从 reasoning 提取文本（复用 vllm_provider 的逻辑）。
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
        }
        try { return JSON.stringify(reasoning); } catch { return String(reasoning); }
    }
    try { return JSON.stringify(reasoning); } catch { return String(reasoning); }
}

/**
 * 注入 OAuth 计费头。
 *
 * Anthropic 要求每个 OAuth 请求都带 billing header，
 * 否则 API 会拒绝请求。
 */
export function applyOAuthBilling(payload: Record<string, unknown>): void {
    const billingBlock = { type: "text", text: DEFAULT_BILLING_HEADER };

    const system = payload.system;
    if (Array.isArray(system)) {
        // 移除已有的 billing block，再插入到最前面
        const filtered = system.filter((b: unknown) => {
            if (!b || typeof b !== "object") return true;
            const text = (b as Record<string, unknown>).text;
            return !(typeof text === "string" && text.includes(DEFAULT_BILLING_HEADER));
        });
        payload.system = [billingBlock, ...filtered];
    } else if (typeof system === "string") {
        payload.system = [billingBlock, { type: "text", text: system }];
    } else {
        payload.system = [billingBlock];
    }
}

/**
 * 自动分配 thinking 预算。
 *
 * Claude 的 thinking 模式需要指定 budget_tokens。
 * 默认分配 max_tokens 的 80%。
 */
export function applyThinkingBudget(payload: Record<string, unknown>): void {
    const thinking = payload.thinking as Record<string, unknown> | undefined;
    if (!thinking || thinking.type !== "enabled") return;
    if (thinking.budget_tokens) return; // 已经有了，不覆盖

    const maxTokens = (payload.max_tokens as number) || 8192;
    thinking.budget_tokens = Math.floor(maxTokens * THINKING_BUDGET_RATIO);
}

/**
 * 创建 Claude 模型实例。
 *
 * 对应原项目 createClaudeChatModel。
 */
export async function createClaudeChatModel(settings: Record<string, unknown>): Promise<unknown> {
    const { ChatAnthropic } = await import("@langchain/anthropic");

    // 检测是否是 OAuth token
    const apiKey = settings.api_key as string || "";
    const isOAuth = isOAuthToken(apiKey);

    // 创建模型
    const model = new ChatAnthropic({
        model: settings.model as string,
        apiKey: apiKey,
        maxTokens: (settings.max_tokens as number) || 4096,
        ...settings,
    });

    return model;
}
