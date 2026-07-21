/**
 * 记忆系统提示模板。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/memory/prompt.py
 *
 * 包含：
 * 1. MEMORY_UPDATE_PROMPT — 记忆更新提示
 * 2. STALENESS_REVIEW_PROMPT — 过期审查提示
 * 3. CONSOLIDATION_PROMPT — 事实合并提示
 * 4. FACT_EXTRACTION_PROMPT — 单条消息事实提取
 * 5. formatMemoryForInjection — 格式化记忆用于系统提示注入
 * 6. 各种辅助函数（token 计数、事实格式化等）
 */

// ─── 提示模板 ──────────────────────────────────────────────────

const MEMORY_UPDATE_PROMPT = `You are a memory management system. Your task is to analyze a conversation and update the user's memory profile.

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
2. Extract relevant facts, preferences, and context with specific details
3. Update the memory sections as needed

{correction_hint}

Memory Section Guidelines:

**User Context** (Current state - concise summaries):
- workContext: Professional role, company, key projects, main technologies (2-3 sentences)
- personalContext: Languages, communication preferences, key interests (1-2 sentences)
- topOfMind: Multiple ongoing focus areas and priorities (3-5 sentences, detailed paragraph)

**History** (Temporal context - rich paragraphs):
- recentMonths: Detailed summary of recent activities (4-6 sentences or 1-2 paragraphs)
- earlierContext: Important historical patterns (3-5 sentences or 1 paragraph)
- longTermBackground: Persistent background and foundational context (2-4 sentences)

**Facts Extraction**:
- Extract specific, quantifiable details
- Include proper nouns (company names, project names, technology names)
- Categories: preference, knowledge, context, behavior, goal, correction
- Confidence levels: 0.9-1.0 (explicit), 0.7-0.8 (strongly implied), 0.5-0.6 (inferred)

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
  "factsToRemove": ["fact_id_1", "fact_id_2"],
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
- Follow length guidelines
- Include specific metrics, version numbers, and proper nouns in facts
- Only add facts that are clearly stated (0.9+) or strongly implied (0.7+)
- Use category "correction" for explicit agent mistakes or user corrections
- Remove facts that are contradicted by new information

{staleness_review_section}

{consolidation_section}

Return ONLY valid JSON, no explanation or markdown.`;

const STALENESS_REVIEW_PROMPT = `## Staleness Review

The following facts were created more than {age_days} days ago and may no longer accurately reflect the user's current situation.

<stale_facts>
{stale_facts}
</stale_facts>

For each fact, decide KEEP or REMOVE:
- KEEP: Still likely valid — even if not mentioned in this conversation.
- REMOVE: Outdated, contradicted by recent context, or no longer relevant.

Add REMOVE decisions to "staleFactsToRemove" in your output JSON.
Each entry must be {{"id": "fact_id", "reason": "brief explanation"}}.

Be conservative — when in doubt, KEEP. Removing a valid fact is worse than keeping a slightly stale one.`;

const CONSOLIDATION_PROMPT = `## Memory Consolidation

The following fact categories have accumulated many individual entries. Review each group and identify facts that can be synthesized into a single, richer consolidated fact.

{consolidation_groups}

For each group, decide:
- CONSOLIDATE: Multiple facts can be merged into one richer fact.
- SKIP: Facts are distinct enough to remain separate.

Add consolidation decisions to "factsToConsolidate" in your output JSON.

Rules:
- The consolidated fact must preserve ALL key details from source facts
- Only consolidate facts that describe the same aspect of the user
- Confidence of consolidated fact = max of source confidences
- Be conservative — when in doubt, keep facts separate`;

const FACT_EXTRACTION_PROMPT = `Extract factual information about the user from this message.

Message:
{message}

Extract facts in this JSON format:
{{
  "facts": [
    {{ "content": "...", "category": "preference|knowledge|context|behavior|goal|correction", "confidence": 0.0-1.0 }}
  ]
}}

Categories:
- preference: User preferences (likes/dislikes, styles, tools)
- knowledge: User's expertise or knowledge areas
- context: Background context (location, job, projects)
- behavior: Behavioral patterns
- goal: User's goals or objectives
- correction: Explicit corrections or mistakes to avoid repeating

Rules:
- Only extract clear, specific facts
- Confidence should reflect certainty (explicit statement = 0.9+, implied = 0.6-0.8)
- Skip vague or temporary information

Return ONLY valid JSON.`;

// ─── Token 计数 ──────────────────────────────────────────────────

/** 基于字符的 token 估算（免网络，支持 CJK） */
function charBasedTokenEstimate(text: string): number {
    let cjk = 0;
    for (const ch of text) {
        if (
            (ch >= "一" && ch <= "鿿") ||  // CJK Unified Ideographs
            (ch >= "぀" && ch <= "ヿ") ||  // Hiragana + Katakana
            (ch >= "가" && ch <= "힣")    // Hangul syllables
        ) {
            cjk++;
        }
    }
    return Math.floor((text.length - cjk) / 4) + Math.floor(cjk / 2);
}

/**
 * 统计文本的 token 数。
 * 默认用字符估算（免网络）。
 * 如果安装了 tiktoken 则用它（更准确）。
 */
export function countTokens(text: string, useTiktoken: boolean = false): number {
    if (!useTiktoken) {
        return charBasedTokenEstimate(text);
    }
    // TODO: 集成 tiktoken（需要 npm 包）
    return charBasedTokenEstimate(text);
}

// ─── 事实格式化 ──────────────────────────────────────────────────

/** 处理置信度值，确保在 [0, 1] 范围内 */
function coerceConfidence(value: unknown, defaultVal: number = 0.0): number {
    let conf: number;
    if (typeof value === "number") {
        conf = value;
    } else if (typeof value === "string") {
        conf = parseFloat(value);
    } else {
        conf = defaultVal;
    }
    if (!isFinite(conf)) conf = defaultVal;
    return Math.max(0, Math.min(1, conf));
}

/** 格式化单个事实行 */
function formatFactLine(fact: Record<string, unknown>): string | null {
    const content = fact.content;
    if (typeof content !== "string" || !content.trim()) return null;
    const category = String(fact.category || "context").trim() || "context";
    const confidence = coerceConfidence(fact.confidence, 0.0);
    const sourceError = fact.sourceError;
    if (category === "correction" && typeof sourceError === "string" && sourceError.trim()) {
        return `- [${category} | ${confidence.toFixed(2)}] ${content} (avoid: ${sourceError.trim()})`;
    }
    return `- [${category} | ${confidence.toFixed(2)}] ${content}`;
}

/**
 * 选择事实行（贪心算法，按 token 预算）。
 */
function selectFactLines(
    rankedFacts: Array<Record<string, unknown>>,
    tokenBudget: number,
    useTiktoken: boolean
): { lines: string[]; consumed: number } {
    const lines: string[] = [];
    let consumed = 0;
    for (const fact of rankedFacts) {
        const formatted = formatFactLine(fact);
        if (!formatted) continue;
        const lineText = lines.length ? "\n" + formatted : formatted;
        const lineTokens = countTokens(lineText, useTiktoken);
        if (consumed + lineTokens > tokenBudget) break;
        lines.push(formatted);
        consumed += lineTokens;
    }
    return { lines, consumed };
}

// ─── 记忆注入格式化 ──────────────────────────────────────────────────

/**
 * 格式化记忆数据用于系统提示注入。
 *
 * 对应原项目 format_memory_for_injection。
 *
 * @param memoryData 记忆数据
 * @param maxTokens 最大 token 数（默认 2000）
 * @param useTiktoken 是否使用 tiktoken 计数
 * @param guaranteedCategories 保证注入的事实类别
 * @param guaranteedTokenBudget 保证注入的 token 预算
 * @returns 格式化后的记忆字符串
 */
export function formatMemoryForInjection(
    memoryData: Record<string, unknown> | null | undefined,
    maxTokens: number = 2000,
    useTiktoken: boolean = false,
    guaranteedCategories?: string[],
    guaranteedTokenBudget: number = 500
): string {
    if (!memoryData) return "";

    const sections: string[] = [];

    // Format user context
    const userData = memoryData.user as Record<string, unknown> | undefined;
    if (userData) {
        const userSections: string[] = [];
        const workCtx = userData.workContext as Record<string, unknown> | undefined;
        if (workCtx?.summary) userSections.push(`Work: ${String(workCtx.summary)}`);
        const personalCtx = userData.personalContext as Record<string, unknown> | undefined;
        if (personalCtx?.summary) userSections.push(`Personal: ${String(personalCtx.summary)}`);
        const topOfMind = userData.topOfMind as Record<string, unknown> | undefined;
        if (topOfMind?.summary) userSections.push(`Current Focus: ${String(topOfMind.summary)}`);
        if (userSections.length > 0) {
            sections.push("User Context:\n" + userSections.map((s) => `- ${s}`).join("\n"));
        }
    }

    // Format history
    const historyData = memoryData.history as Record<string, unknown> | undefined;
    if (historyData) {
        const historySections: string[] = [];
        const recent = historyData.recentMonths as Record<string, unknown> | undefined;
        if (recent?.summary) historySections.push(`Recent: ${String(recent.summary)}`);
        const earlier = historyData.earlierContext as Record<string, unknown> | undefined;
        if (earlier?.summary) historySections.push(`Earlier: ${String(earlier.summary)}`);
        const background = historyData.longTermBackground as Record<string, unknown> | undefined;
        if (background?.summary) historySections.push(`Background: ${String(background.summary)}`);
        if (historySections.length > 0) {
            sections.push("History:\n" + historySections.map((s) => `- ${s}`).join("\n"));
        }
    }

    // Format facts
    const factsData = memoryData.facts;
    let guaranteedLineTokens = 0;
    let allFactLines: string[] = [];

    if (Array.isArray(factsData) && factsData.length > 0) {
        const factsHeader = "Facts:\n";
        const baseText = sections.join("\n\n");
        const baseTokens = baseText ? countTokens(baseText, useTiktoken) : 0;
        const validFacts = factsData.filter(
            (f: unknown) => f && typeof f === "object" && typeof (f as Record<string, unknown>).content === "string"
        ) as Array<Record<string, unknown>>;

        try {
            const guaranteedSet = new Set(guaranteedCategories?.map((c) => c.trim()).filter(Boolean) ?? []);

            // 按置信度降序排序
            const sortedFacts = [...validFacts].sort(
                (a, b) => coerceConfidence(b.confidence, 0) - coerceConfidence(a.confidence, 0)
            );

            let guaranteed: Array<Record<string, unknown>> = [];
            let regular: Array<Record<string, unknown>> = [];

            if (guaranteedSet.size > 0) {
                guaranteed = sortedFacts.filter((f) => guaranteedSet.has(String(f.category ?? "").trim()));
                regular = sortedFacts.filter((f) => !guaranteedSet.has(String(f.category ?? "").trim()));
            } else {
                regular = sortedFacts;
            }

            const guaranteedLines: string[] = [];
            if (guaranteed.length > 0) {
                const result = selectFactLines(guaranteed, guaranteedTokenBudget, useTiktoken);
                guaranteedLines.push(...result.lines);
                guaranteedLineTokens = result.consumed;
            }

            const regularLines: string[] = [];
            if (regular.length > 0) {
                const interGroupNewlineTokens = guaranteedLines.length ? countTokens("\n", useTiktoken) : 0;
                const usedBeforeRegular = baseTokens + countTokens(factsHeader, useTiktoken) + guaranteedLineTokens + interGroupNewlineTokens;
                const regularLineBudget = maxTokens - usedBeforeRegular;
                if (regularLineBudget > 0) {
                    const result = selectFactLines(regular, regularLineBudget, useTiktoken);
                    regularLines.push(...result.lines);
                }
            }

            allFactLines = [...guaranteedLines, ...regularLines];
            if (allFactLines.length > 0) {
                sections.push(factsHeader + allFactLines.join("\n"));
            }
        } catch {
            // 备用：简单置信度排序
            const ranked = [...validFacts].sort(
                (a, b) => coerceConfidence(b.confidence, 0) - coerceConfidence(a.confidence, 0)
            );
            const headerCost = countTokens("Facts:\n", useTiktoken);
            const lineBudget = maxTokens - baseTokens - headerCost;
            if (lineBudget > 0) {
                const result = selectFactLines(ranked, lineBudget, useTiktoken);
                allFactLines = result.lines;
                if (allFactLines.length > 0) {
                    sections.push("Facts:\n" + allFactLines.join("\n"));
                }
            }
        }
    }

    if (sections.length === 0) return "";
    return sections.join("\n\n");
}

// ─── 提示构建函数 ──────────────────────────────────────────────────

/**
 * 构建记忆更新提示。
 */
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

/**
 * 构建过期审查提示。
 */
export function buildStalenessReviewPrompt(
    staleFacts: string,
    ageDays: number = 90
): string {
    return STALENESS_REVIEW_PROMPT
        .replace("{age_days}", String(ageDays))
        .replace("{stale_facts}", staleFacts);
}

/**
 * 构建事实合并提示。
 */
export function buildConsolidationPrompt(
    consolidationGroups: string
): string {
    return CONSOLIDATION_PROMPT
        .replace("{consolidation_groups}", consolidationGroups);
}

/**
 * 构建单条消息事实提取提示。
 */
export function buildFactExtractionPrompt(message: string): string {
    return FACT_EXTRACTION_PROMPT.replace("{message}", message);
}
