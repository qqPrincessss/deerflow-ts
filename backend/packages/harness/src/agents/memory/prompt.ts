/**
 * 记忆系统提示模板和格式化工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/memory/prompt.py
 */

// ════════════════════════════════════════════════════════════════
// 1. 提示模板常量
// ════════════════════════════════════════════════════════════════

export const MEMORY_UPDATE_PROMPT = `You are a memory management system. Your task is to analyze a conversation and update the user's memory profile.

Current Memory State:
<current_memory>
{current_memory}
</current_memory>

New Conversation to Process:
<conversation>
{conversation}
</conversation>

Instructions:
1. Analyze the conversation for important information about the user
2. Extract relevant facts, preferences, and context with specific details (numbers, names, technologies)
3. Update the memory sections as needed following the detailed length guidelines below

{correction_hint}

Output Format (JSON):
{{
  "user": {{
    "workContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "personalContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "topOfMind": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "history": {{
    "recentMonths": {{ "summary": "...", "shouldUpdate": true/false }},
    "earlierContext": {{ "summary": "...", "shouldUpdate": true/false }},
    "longTermBackground": {{ "summary": "...", "shouldUpdate": true/false }}
  }},
  "newFacts": [
    {{ "content": "...", "category": "preference|knowledge|context|behavior|goal|correction", "confidence": 0.0-1.0 }}
  ],
  "factsToRemove": ["fact_id_1"],
  "staleFactsToRemove": [{{ "id": "fact_id", "reason": "brief explanation" }}],
  "factsToConsolidate": [
    {{
      "sourceIds": ["fact_id_1", "fact_id_2"],
      "consolidated": {{ "content": "synthesized fact", "category": "knowledge", "confidence": 0.9 }}
    }}
  ]
}}

Important Rules:
- Only set shouldUpdate=true if there's meaningful new information
- Include specific metrics, version numbers, and proper nouns in facts
- Only add facts that are clearly stated (0.9+) or strongly implied (0.7+)
- Remove facts that are contradicted by new information

{staleness_review_section}

{consolidation_section}

Return ONLY valid JSON, no explanation or markdown.`;

export const STALENESS_REVIEW_PROMPT = `## Staleness Review

The following facts were created more than {age_days} days ago and may no longer accurately reflect the user's current situation.

<stale_facts>
{stale_facts}
</stale_facts>

For each fact, decide KEEP or REMOVE.

Add REMOVE decisions to "staleFactsToRemove" in your output JSON.
Each entry must be {{"id": "fact_id", "reason": "brief explanation"}}.

Be conservative — when in doubt, KEEP.`;

export const CONSOLIDATION_PROMPT = `## Memory Consolidation

The following fact categories have accumulated many individual entries.
Review each group and identify facts that can be synthesized into a single, richer consolidated fact.

{consolidation_groups}

For each group, decide CONSOLIDATE or SKIP.

Add consolidation decisions to "factsToConsolidate" in your output JSON.
Each entry: {{"sourceIds": ["fact_id_1"], "consolidated": {{"content": "...", "category": "knowledge", "confidence": 0.9}}}}`;

const FACT_EXTRACTION_PROMPT = `Extract factual information about the user from this message.

Message:
{message}

Extract facts in this JSON format:
{{
  "facts": [
    {{ "content": "...", "category": "preference|knowledge|context|behavior|goal|correction", "confidence": 0.0-1.0 }}
  ]
}}

Return ONLY valid JSON.`;
function _charBasedTokenEstimate(text: string): number {
    let cjk = 0;
    for (const ch of text) {
        // 判断是否是 CJK 字符
        if ((ch >= "\u4e00" && ch <= "\u9fff") ||
            (ch >= "\u3040" && ch <= "\u30ff") ||
            (ch >= "\uac00" && ch <= "\ud7a3")) {
            cjk++;
        }
    }
    return Math.floor((text.length - cjk) / 4) + Math.floor(cjk / 2);
}
export function _countTokens(text: string, useTiktoken: boolean = false): number {
    if (useTiktoken) {
        try {
            const { encode } = require("gpt-tokenizer");
            return encode(text).length;
        } catch {
            return _charBasedTokenEstimate(text);
        }
    }
    return _charBasedTokenEstimate(text);
}

export function warmTiktokenCache(): boolean {
    try {
        require("gpt-tokenizer");
        return true;
    } catch {
        return false;
    }
}

function _coerceConfidence(value: unknown, defaultVal: number = 0.0): number {
    let conf: number;
    if (typeof value === "number") {
        conf = value;
    } else if (typeof value === "string") {
        conf = parseFloat(value);
    } else {
        conf = defaultVal;
    }
    if (!isFinite(conf)) {
        conf = defaultVal;
    }
    return Math.max(0, Math.min(1, conf));
}

//把fact变成文字
function _formatFactLine(fact: Record<string, unknown>): string | null {
    const content = fact.content;
    if (typeof content !== "string" || !content.trim()) return null;

    const category = String(fact.category || "context").trim() || "context";
    const confidence = _coerceConfidence(fact.confidence, 0);
    return `- [${category} | ${confidence.toFixed(2)}] ${content}`;
}
//  作用：防止用户信息攻击。用户的记忆内容可能是 </memory> 这种能破坏 HTML 结构的字符，转义后无害了。
function _escapeSummary(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function _selectFactLines(
    ranked: Array<Record<string, unknown>>,// 已按置信度降序排列的事实列表
    budget: number,// token 预算（最多能用多少 token）
    useTik: boolean// 是否用 gpt-tokenizer 计数
): { lines: string[]; consumed: number } {// 返回 { 选中的行, 用了多少 token }
    const lines: string[] = [];
    let consumed = 0;
    for (const fact of ranked) {
        const f = _formatFactLine(fact);
        if (!f) continue;
        const lineText = lines.length === 0 ? f : "\n" + f;
        const tokens = _countTokens(lineText, useTik);
        if (consumed + tokens > budget) break;
        lines.push(f);
        consumed += tokens;
    }
    return { lines, consumed };
}

// 逻辑：
//   1. 按置信度排序
//   2. 算预算
//   3. 用 _selectFactLines 挑选
//   4. 返回格式化结果
function _fallbackFormatFacts(
    validFacts: Array<Record<string, unknown>>,
    precedingSectionCost: number,
    maxTokens: number,
    useTiktoken: boolean
): { sectionText: string | null; lines: string[] } {
    const ranked = [...validFacts].sort(
        (a, b) => _coerceConfidence(b.confidence, 0) - _coerceConfidence(a.confidence, 0)
    );
    const header = "Facts:\n";
    const overhead = _countTokens(header, useTiktoken);
    const lineBudget = maxTokens - precedingSectionCost - overhead;
    if (lineBudget <= 0) return { sectionText: null, lines: [] };

    const { lines } = _selectFactLines(ranked, lineBudget, useTiktoken);
    if (lines.length === 0) return { sectionText: null, lines: [] };

    return { sectionText: header + lines.join("\n"), lines };
}

export function formatMemoryForInjection(
      memoryData: Record<string, unknown> | null | undefined,
      maxTokens: number = 2000,
      useTiktoken: boolean = false,
      guaranteedCategories?: string[],
      guaranteedTokenBudget: number = 500
  ): string {
    if (!memoryData) return "";
    const sections: string[] = [];

    // 1. 处理 user 字段
    const ud = memoryData.user as Record<string, unknown> | undefined;
    if (ud) {
        const us: string[] = [];
        const w = ud.workContext as Record<string, unknown> | undefined;
        if (w?.summary) us.push(`Work: ${_escapeSummary(w.summary)}`);
        const p = ud.personalContext as Record<string, unknown> | undefined;
        if (p?.summary) us.push(`Personal: ${_escapeSummary(p.summary)}`);
        const t = ud.topOfMind as Record<string, unknown> | undefined;
        if (t?.summary) us.push(`Current Focus: ${_escapeSummary(t.summary)}`);
        if (us.length) sections.push("User Context:\n" + us.map((s) => `- ${s}`).join("\n"));
    }

    // 2. 处理 history 字段
    const hd = memoryData.history as Record<string, unknown> | undefined;
    if (hd) {
        const hs: string[] = [];
        const r = hd.recentMonths as Record<string, unknown> | undefined;
        if (r?.summary) hs.push(`Recent: ${_escapeSummary(r.summary)}`);
        const e = hd.earlierContext as Record<string, unknown> | undefined;
        if (e?.summary) hs.push(`Earlier: ${_escapeSummary(e.summary)}`);
        const b = hd.longTermBackground as Record<string, unknown> | undefined;
        if (b?.summary) hs.push(`Background: ${_escapeSummary(b.summary)}`);
        if (hs.length) sections.push("History:\n" + hs.map((s) => `- ${s}`).join("\n"));
    }

    // 3. 处理 facts 字段
    const fh = "Facts:\n";
    const fd = memoryData.facts;
    const afl: string[] = [];

    if (Array.isArray(fd) && fd.length > 0) {
        const bt = _countTokens(sections.join("\n\n"), useTiktoken);
        const vf = fd.filter((f): f is Record<string, unknown> =>
            f !== null && typeof f === "object"
        );

        try {
            const sf = [...vf].sort(
                (a, b) => _coerceConfidence(b.confidence, 0) - _coerceConfidence(a.confidence, 0)
            );
            const rl = _selectFactLines(sf, maxTokens - bt - _countTokens(fh, useTiktoken), useTiktoken);
            if (rl.lines.length) sections.push(fh + rl.lines.join("\n"));
        } catch {
            const fb = _fallbackFormatFacts(vf, bt, maxTokens, useTiktoken);
            if (fb.sectionText) sections.push(fb.sectionText);
        }
    }

    if (!sections.length) return "";
    return sections.join("\n\n");
  }

// ════════════════════════════════════════════════════════════════
// 5. 提示构建函数
// ════════════════════════════════════════════════════════════════

export function buildMemoryUpdatePrompt(
    currentMemory: string,
    conversation: string
): string {
    return MEMORY_UPDATE_PROMPT
        .replace("{current_memory}", currentMemory)
        .replace("{conversation}", conversation)
        .replace("{correction_hint}", "")
        .replace("{staleness_review_section}", "")
        .replace("{consolidation_section}", "");
}

export function buildStalenessReviewPrompt(staleFacts: string, ageDays: number = 90): string {
    return STALENESS_REVIEW_PROMPT
        .replace("{age_days}", String(ageDays))
        .replace("{stale_facts}", staleFacts);
}

export function buildConsolidationPrompt(consolidationGroups: string): string {
    return CONSOLIDATION_PROMPT.replace("{consolidation_groups}", consolidationGroups);
}

export function buildFactExtractionPrompt(message: string): string {
    return FACT_EXTRACTION_PROMPT.replace("{message}", message);
}

/**
 * 把消息列表格式化成对话文本，用于记忆更新提示。
 *
 * 对应原项目 format_conversation_for_update。
 *
 * @param messages 消息列表（每条需要有 type 和 content）
 * @returns 格式化后的对话文本
 */
export function formatConversationForUpdate(
    messages: Array<{ type: string; content: unknown }>
): string {
    const lines: string[] = [];
    const uploadTagRe = /<uploaded_files>[\s\S]*?<\/uploaded_files>\n*/g;

    for (const msg of messages) {
        const role = msg.type || "unknown";
        let content = msg.content;

        // 处理多模态内容（数组格式）
        if (Array.isArray(content)) {
            const textParts: string[] = [];
            for (const p of content) {
                if (typeof p === "string") {
                    textParts.push(p);
                } else if (p && typeof p === "object") {
                    const textVal = (p as Record<string, unknown>).text;
                    if (typeof textVal === "string") {
                        textParts.push(textVal);
                    }
                }
            }
            content = textParts.length > 0 ? textParts.join(" ") : String(content);
        }

        let contentStr = String(content);

        // 去掉 human 消息中的 uploaded_files 标签
        if (role === "human") {
            contentStr = contentStr.replace(uploadTagRe, "").trim();
            if (!contentStr) continue;
        }

        // 截断过长的消息
        if (contentStr.length > 1000) {
            contentStr = contentStr.slice(0, 1000) + "...";
        }

        // HTML 转义（防止注入攻击）
        contentStr = contentStr
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        if (role === "human") {
            lines.push(`User: ${contentStr}`);
        } else if (role === "ai") {
            lines.push(`Assistant: ${contentStr}`);
        }
    }

    return lines.join("\n\n");
}