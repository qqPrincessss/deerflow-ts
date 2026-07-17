/**
 * LLM 文本处理工具函数。
 *
 * 对应原项目：backend/packages/harness/deerflow/utils/llm_text.py
 */

/** 匹配完整的 <think>...</think> 块 */
const THINK_BLOCK_RE = /<think\b[^>]*>.*?<\/think\s*>/gis;

/** 匹配未闭合的 <think> 开始标签 */
const OPEN_THINK_RE = /<think\b[^>]*>/i;

/**
 * 去掉 LLM 回复中的 <think>...</think> 块。
 *
 * 推理模型（如 DeepSeek-R1）会在回复里加 think 块，
 * 这是模型的"思考过程"，用户不需要看到。
 */
export function stripThinkBlocks(text: string, truncateUnclosed: boolean = true): string {
    let result = text.replace(THINK_BLOCK_RE, "");
    if (truncateUnclosed) {
        const openMatch = OPEN_THINK_RE.exec(result);
        if (openMatch) {
            result = result.slice(0, openMatch.index);
        }
    }
    return result.trim();
}

/**
 * 去掉 markdown 代码围栏。
 */
export function stripMarkdownCodeFence(text: string): string {
    const stripped = text.trim();
    if (!stripped.startsWith("```")) {
        return stripped;
    }
    const lines = stripped.split("\n");
    if (lines.length >= 3 && lines[0].startsWith("```") && lines[lines.length - 1].startsWith("```")) {
        return lines.slice(1, -1).join("\n").trim();
    }
    return stripped;
}

/**
 * 从 LLM 响应中提取文本。
 */
export function extractResponseText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            if (typeof block === "string") {
                parts.push(block);
            } else if (block && typeof block === "object") {
                const obj = block as Record<string, unknown>;
                if (obj.type === "text" || obj.type === "output_text") {
                    if (typeof obj.text === "string") {
                        parts.push(obj.text);
                    }
                }
            }
        }
        return parts.join("\n");
    }
    if (content === null || content === undefined) {
        return "";
    }
    return String(content);
}
