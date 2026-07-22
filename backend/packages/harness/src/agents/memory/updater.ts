/**
 * 记忆更新器 — 读取、写入、更新记忆数据。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/memory/updater.py (1236行)
 */

import { getMemoryStorage, createEmptyMemory } from "./storage.js";
import {
    MEMORY_UPDATE_PROMPT,
    STALENESS_REVIEW_PROMPT,
    CONSOLIDATION_PROMPT,
    formatConversationForUpdate,
} from "./prompt.js";
import { getAppConfig } from "../../config/app_config.js";
import { createChatModel } from "../../models/factory.js";
import { type MemoryConfig } from "../../config/memory_config.js";

// ════════════════════════════════════════════════════════════════
// 正则
// ════════════════════════════════════════════════════════════════

const UPLOAD_SENTENCE_RE = /[^.]*?upload(?:ed)?\s+file[s]?[^.]*\./gi;
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;

// ════════════════════════════════════════════════════════════════
// CRUD 函数（storage 是 async 的，所以这些也是 async）
// ════════════════════════════════════════════════════════════════

export async function getMemoryData(
    agentName?: string,
    userId?: string
): Promise<Record<string, unknown>> {
    const storage = getMemoryStorage();
    return await storage.load(agentName, userId);
}

export async function saveMemoryToFile(
    memoryData: Record<string, unknown>,
    agentName?: string,
    userId?: string
): Promise<boolean> {
    const storage = getMemoryStorage();
    return await storage.save(memoryData, agentName, userId);
}

export async function importMemoryData(
    memoryData: Record<string, unknown>,
    agentName?: string,
    userId?: string
): Promise<Record<string, unknown>> {
    const storage = getMemoryStorage();
    const saved = await storage.save(memoryData, agentName, userId);
    if (!saved) {
        throw new Error("Failed to save imported memory data");
    }
    return await storage.load(agentName, userId);
}

export async function reloadMemoryData(
    agentName?: string,
    userId?: string
): Promise<Record<string, unknown>> {
    const storage = getMemoryStorage();
    return await storage.reload(agentName, userId);
}

export async function clearMemoryData(
    agentName?: string,
    userId?: string
): Promise<Record<string, unknown>> {
    const cleared = createEmptyMemory();
    const storage = getMemoryStorage();
    await storage.save(cleared, agentName, userId);
    return cleared;
}

function _validateConfidence(confidence: number): number {
    if (!isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error("confidence must be a finite number in [0, 1]");
    }
    return confidence;
}

export async function createMemoryFactWithCreatedFact(
    content: string,
    category: string = "context",
    confidence: number = 0.5,
    agentName?: string,
    userId?: string
): Promise<{ memoryData: Record<string, unknown>; createdFact: Record<string, unknown> }> {
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new Error("content cannot be empty");
    const validatedConfidence = _validateConfidence(confidence);

    const storage = getMemoryStorage();
    const memoryData = await storage.load(agentName, userId);
    const facts = [...((memoryData.facts as Array<Record<string, unknown>>) || [])];

    const now = new Date().toISOString();
    const createdFact: Record<string, unknown> = {
        id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        content: normalizedContent,
        category: category.trim() || "context",
        confidence: validatedConfidence,
        createdAt: now,
        source: "manual",
    };
    facts.push(createdFact);

    const updatedMemory = { ...memoryData, facts: _trimFactsToMax(facts) };
    await storage.save(updatedMemory, agentName, userId);
    return { memoryData: updatedMemory, createdFact };
}

export async function createMemoryFact(
    content: string,
    category: string = "context",
    confidence: number = 0.5,
    agentName?: string,
    userId?: string
): Promise<Record<string, unknown>> {
    const normalizedContent = content.trim();
    if (!normalizedContent) throw new Error("content cannot be empty");
    const validatedConfidence = _validateConfidence(confidence);

    const storage = getMemoryStorage();
    const memoryData = await storage.load(agentName, userId);
    const facts = [...((memoryData.facts as Array<Record<string, unknown>>) || [])];

    const now = new Date().toISOString();
    const createdFact: Record<string, unknown> = {
        id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        content: normalizedContent,
        category: category.trim() || "context",
        confidence: validatedConfidence,
        createdAt: now,
        source: "manual",
    };
    facts.push(createdFact);

    const updated = { ...memoryData, facts: _trimFactsToMax(facts) };
    await storage.save(updated, agentName, userId);
    return createdFact;
}

export async function deleteMemoryFact(
    factId: string,
    agentName?: string,
    userId?: string
): Promise<Record<string, unknown>> {
    const storage = getMemoryStorage();
    const memoryData = await storage.load(agentName, userId);
    const facts = (memoryData.facts as Array<Record<string, unknown>>) || [];
    const updatedFacts = facts.filter((f) => String(f.id ?? "") !== factId);

    if (updatedFacts.length === facts.length) {
        throw new Error(`Fact '${factId}' not found`);
    }

    const updated = { ...memoryData, facts: updatedFacts };
    await storage.save(updated, agentName, userId);
    return updated;
}

export async function searchMemoryFacts(
    query: string,
    category?: string,
    limit: number = 10,
    agentName?: string,
    userId?: string
): Promise<Array<Record<string, unknown>>> {
    if (!query || !query.trim() || limit <= 0) return [];
    const queryLower = query.trim().toLowerCase();

    const storage = getMemoryStorage();
    const memoryData = await storage.load(agentName, userId);
    const facts = (memoryData.facts as Array<Record<string, unknown>>) || [];

    return facts
        .filter((fact) => {
            const content = String(fact.content || "");
            if (!content.toLowerCase().includes(queryLower)) return false;
            if (category && fact.category !== category) return false;
            return true;
        })
        .sort((a, b) => _coerceSourceConfidence(b) - _coerceSourceConfidence(a))
        .slice(0, limit);
}

export async function updateMemoryFact(
    factId: string,
    content?: string,
    category?: string,
    confidence?: number,
    agentName?: string,
    userId?: string
): Promise<Record<string, unknown>> {
    const storage = getMemoryStorage();
    const memoryData = await storage.load(agentName, userId);
    const facts = (memoryData.facts as Array<Record<string, unknown>>) || [];
    let found = false;

    const updatedFacts = facts.map((fact) => {
        if (String(fact.id ?? "") !== factId) return fact;
        found = true;
        const updated = { ...fact };
        if (content !== undefined) {
            const trimmed = content.trim();
            if (!trimmed) throw new Error("content cannot be empty");
            updated.content = trimmed;
        }
        if (category !== undefined) {
            updated.category = category.trim() || "context";
        }
        if (confidence !== undefined) {
            updated.confidence = _validateConfidence(confidence);
        }
        return updated;
    });

    if (!found) throw new Error(`Fact '${factId}' not found`);

    const updated = { ...memoryData, facts: updatedFacts };
    await storage.save(updated, agentName, userId);
    return updated;
}

function _coerceSourceConfidence(fact: Record<string, unknown>): number {
    const raw = fact.confidence;
    if (raw === null || raw === undefined || typeof raw === "boolean") return 0.5;
    try {
        const val = Number(raw);
        return isFinite(val) ? Math.max(0, Math.min(val, 1)) : 0.5;
    } catch {
        return 0.5;
    }
}

function _trimFactsToMax(
    facts: Array<Record<string, unknown>>,
    maxFacts: number = 100
): Array<Record<string, unknown>> {
    if (facts.length <= maxFacts) return facts;
    return [...facts]
        .sort((a, b) => _coerceSourceConfidence(b) - _coerceSourceConfidence(a))
        .slice(0, maxFacts);
}

function _extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
            if (typeof block === "string") parts.push(block);
            else if (block && typeof block === "object") {
                const text = (block as Record<string, unknown>).text;
                if (typeof text === "string") parts.push(text);
            }
        }
        return parts.join("\n");
    }
    return String(content ?? "");
}

function _normalizeMemoryUpdateFact(
    fact: unknown
): Record<string, unknown> | null {
    if (!fact || typeof fact !== "object") return null;
    const f = fact as Record<string, unknown>;

    const rawContent = f.content;
    if (typeof rawContent !== "string" || !rawContent.trim()) return null;

    const rawCategory = f.category;
    const category =
        typeof rawCategory === "string" && rawCategory.trim()
            ? rawCategory.trim()
            : "context";

    const rawConfidence = f.confidence;
    let confidenceNum: number;

    if (
        rawConfidence === null ||
        rawConfidence === undefined ||
        typeof rawConfidence === "boolean"
    )
        return null;
    if (typeof rawConfidence === "string") {
        const trimmed = rawConfidence.trim();
        if (!trimmed) return null;
        confidenceNum = parseFloat(trimmed);
        if (isNaN(confidenceNum)) return null;
    } else if (typeof rawConfidence === "number") {
        confidenceNum = Number(rawConfidence);
    } else {
        return null;
    }
    if (!isFinite(confidenceNum)) return null;

    const normalized: Record<string, unknown> = {
        content: rawContent.trim(),
        category,
        confidence: Math.max(0, Math.min(confidenceNum, 1)),
    };

    const sourceError = f.sourceError;
    if (typeof sourceError === "string" && sourceError.trim()) {
        normalized.sourceError = sourceError.trim();
    }

    return normalized;
}

function _normalizeMemoryUpdateData(
    updateData: Record<string, unknown>
): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    const user = updateData.user;
    if (user && typeof user === "object") result.user = user;

    const history = updateData.history;
    if (history && typeof history === "object") result.history = history;

    const rawNewFacts = updateData.newFacts;
    if (Array.isArray(rawNewFacts)) {
        const normalized: Array<Record<string, unknown>> = [];
        for (const f of rawNewFacts) {
            const nf = _normalizeMemoryUpdateFact(f);
            if (nf) normalized.push(nf);
        }
        if (normalized.length > 0) result.newFacts = normalized;
    }

    const rawFactsToRemove = updateData.factsToRemove;
    if (Array.isArray(rawFactsToRemove)) {
        const ids = rawFactsToRemove.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0
        );
        if (ids.length > 0) result.factsToRemove = ids;
    }

    const rawStale = updateData.staleFactsToRemove;
    if (Array.isArray(rawStale)) {
        const ids: string[] = [];
        for (const entry of rawStale) {
            if (entry && typeof entry === "object") {
                const id = (entry as Record<string, unknown>).id;
                if (typeof id === "string" && id.trim().length > 0) {
                    ids.push(id.trim());
                }
            }
        }
        if (ids.length > 0) result.staleFactsToRemove = ids;
    }

    const rawConsolidate = updateData.factsToConsolidate;
    if (rawConsolidate) result.factsToConsolidate = rawConsolidate;

    const factsToUpdate = updateData.factsToUpdate;
    if (factsToUpdate) result.factsToUpdate = factsToUpdate;

    return result;
}

function _parseMemoryUpdateResponse(
    responseContent: unknown
): Record<string, unknown> {
    const text = _extractText(responseContent).trim();
    if (!text) return {};

    let jsonStr = text;
    const fenceMatch = text.match(FENCE_RE);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    try {
        return JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
        const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (braceMatch) {
            try {
                return JSON.parse(braceMatch[0]) as Record<string, unknown>;
            } catch {
                return {};
            }
        }
        return {};
    }
}

function _factContentKey(content: unknown): string | null {
    if (typeof content !== "string") return null;
    const trimmed = content.trim();
    return trimmed ? trimmed.toLowerCase() : null;
}

function _parseFactDatetime(raw: string): Date | null {
    if (!raw) return null;
    try {
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    } catch {
        return null;
    }
}

function _stripUploadMentionsFromMemory(
    memoryData: Record<string, unknown>
): Record<string, unknown> {
    const result = { ...memoryData };

    for (const section of ["user", "history"]) {
        const sectionData = result[section] as Record<string, unknown> | undefined;
        if (!sectionData) continue;
        for (const val of Object.values(sectionData)) {
            const entry = val as Record<string, unknown> | undefined;
            if (entry?.summary && typeof entry.summary === "string") {
                entry.summary = entry.summary
                    .replace(UPLOAD_SENTENCE_RE, "")
                    .trim()
                    .replace(/\s{2,}/g, " ");
            }
        }
    }

    const facts = result.facts as Array<Record<string, unknown>> | undefined;
    if (facts) {
        result.facts = facts.filter((f) => {
            const content = f.content;
            return !(typeof content === "string" && UPLOAD_SENTENCE_RE.test(content));
        });
    }

    return result;
}

function _escapeMemoryForPrompt(memory: unknown): unknown {
    if (typeof memory === "string") {
        return memory
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
    if (Array.isArray(memory)) {
        return memory.map(_escapeMemoryForPrompt);
    }
    if (memory && typeof memory === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(
            memory as Record<string, unknown>
        )) {
            result[key] = _escapeMemoryForPrompt(value);
        }
        return result;
    }
    return memory;
}

function _applyUpdates(
    memoryData: Record<string, unknown>,
    updates: Record<string, unknown>
): Record<string, unknown> {
    const updated = { ...memoryData };
    const now = new Date().toISOString();

    const userUpdate = updates.user as Record<string, unknown> | undefined;
    if (userUpdate) {
        const currentUser = (updated.user as Record<string, unknown>) || {};
        const newUser: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(userUpdate)) {
            const section = val as Record<string, unknown> | undefined;
            if (!!section?.shouldUpdate && section?.summary) {
                newUser[key] = { summary: section.summary, updatedAt: now };
            } else {
                newUser[key] = currentUser[key] || { summary: "", updatedAt: "" };
            }
        }
        updated.user = { ...currentUser, ...newUser };
    }

    const historyUpdate = updates.history as Record<string, unknown> | undefined;
    if (historyUpdate) {
        const currentHistory =
            (updated.history as Record<string, unknown>) || {};
        const newHistory: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(historyUpdate)) {
            const section = val as Record<string, unknown> | undefined;
            if (!!section?.shouldUpdate && section?.summary) {
                newHistory[key] = { summary: section.summary, updatedAt: now };
            } else {
                newHistory[key] =
                    currentHistory[key] || { summary: "", updatedAt: "" };
            }
        }
        updated.history = { ...currentHistory, ...newHistory };
    }

    let facts = [
        ...((updated.facts as Array<Record<string, unknown>>) || []),
    ];

    const removeIds = new Set([
        ...((updates.factsToRemove as string[]) || []),
        ...((updates.staleFactsToRemove as string[]) || []),
    ]);
    if (removeIds.size > 0) {
        facts = facts.filter((f) => !removeIds.has(String(f.id ?? "")));
    }

    const newFactsData = updates.newFacts as
        | Array<Record<string, unknown>>
        | undefined;
    if (newFactsData) {
        const existingKeys = new Set(
            facts.map((f) => _factContentKey(f.content)).filter(Boolean)
        );
        for (const nf of newFactsData) {
            const key = _factContentKey(nf.content);
            if (key && !existingKeys.has(key)) {
                facts.push({
                    id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    ...nf,
                    createdAt: now,
                });
                if (key) existingKeys.add(key);
            }
        }
    }

    const updateFactsData = updates.factsToUpdate as
        | Array<Record<string, unknown>>
        | undefined;
    if (updateFactsData) {
        const updateMap = new Map<string, Record<string, unknown>>();
        for (const uf of updateFactsData) {
            const uid = uf.id;
            if (typeof uid === "string" && uid) updateMap.set(uid, uf);
        }
        if (updateMap.size > 0) {
            facts = facts.map((f) => {
                const id = String(f.id ?? "");
                const u = updateMap.get(id);
                return u ? { ...f, ...u, id: f.id, createdAt: f.createdAt } : f;
            });
        }
    }

    updated.facts = _trimFactsToMax(facts);
    return updated;
}

// ════════════════════════════════════════════════════════════════
// 过期审查
// ════════════════════════════════════════════════════════════════

function _selectStaleCandidates(
    currentMemory: Record<string, unknown>,
    config: MemoryConfig
): Array<Record<string, unknown>> {
    const cutoff = Date.now() - config.staleness_age_days * 24 * 60 * 60 * 1000;
    const protectedSet = new Set(config.staleness_protected_categories || []);
    const facts = currentMemory.facts as
        | Array<Record<string, unknown>>
        | undefined;
    if (!facts) return [];

    return facts.filter((fact) => {
        if (!fact || typeof fact !== "object") return false;
        const category = String(fact.category || "");
        if (protectedSet.has(category)) return false;
        const createdAt = fact.createdAt;
        const dt = typeof createdAt === "string" ? _parseFactDatetime(createdAt) : null;
        return dt !== null && dt.getTime() < cutoff;
    });
}

function _buildStalenessSection(
    staleCandidates: Array<Record<string, unknown>>,
    ageDays: number
): string {
    if (staleCandidates.length === 0) return "";
    const lines: string[] = [];
    for (const fact of staleCandidates) {
        const fid = fact.id ?? "?";
        const cat = String(fact.category || "context");
        const conf = _coerceSourceConfidence(fact);
        const createdRaw = String(fact.createdAt || "");
        const createdShort =
            createdRaw.length >= 10 ? createdRaw.slice(0, 10) : createdRaw;
        const content = String(fact.content || "");
        lines.push(
            `- [${fid} | ${cat} | ${conf.toFixed(2)} | ${createdShort}] "${content}"`
        );
    }
    return STALENESS_REVIEW_PROMPT.replace("{age_days}", String(ageDays)).replace(
        "{stale_facts}",
        lines.join("\n")
    );
}

// ════════════════════════════════════════════════════════════════
// 事实合并
// ════════════════════════════════════════════════════════════════

function _selectConsolidationCandidates(
    currentMemory: Record<string, unknown>,
    config: MemoryConfig
): Record<string, Array<Record<string, unknown>>> {
    const facts = currentMemory.facts as
        | Array<Record<string, unknown>>
        | undefined;
    if (!facts) return {};

    const byCategory: Record<string, Array<Record<string, unknown>>> = {};
    const protectedSet = new Set(config.staleness_protected_categories || []);

    for (const fact of facts) {
        if (!fact || typeof fact !== "object") continue;
        const cat = String(fact.category || "context").trim();
        if (cat && !protectedSet.has(cat)) {
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(fact);
        }
    }

    const threshold = config.consolidation_min_facts || 8;
    const result: Record<string, Array<Record<string, unknown>>> = {};
    for (const [cat, group] of Object.entries(byCategory)) {
        if (group.length >= threshold) {
            result[cat] = group;
        }
    }
    return result;
}

function _buildConsolidationSection(
    candidates: Record<string, Array<Record<string, unknown>>>,
    maxGroups: number = 3,
    maxSources: number = 8
): string {
    const keys = Object.keys(candidates);
    if (keys.length === 0) return "";

    const sorted = keys.sort(
        (a, b) =>
            candidates[b].length - candidates[a].length || a.localeCompare(b)
    );
    const parts: string[] = [];

    for (const cat of sorted.slice(0, maxGroups)) {
        const group = candidates[cat].slice(0, maxSources);
        const lines: string[] = [];
        for (const fact of group) {
            const fid = fact.id ?? "?";
            const conf = _coerceSourceConfidence(fact);
            const content = String(fact.content || "");
            lines.push(`- [${fid} | ${conf.toFixed(2)}] "${content}"`);
        }
        parts.push(
            `<consolidation_candidates category="${cat}" count="${group.length}">\n${lines.join("\n")}\n</consolidation_candidates>`
        );
    }

    return CONSOLIDATION_PROMPT.replace(
        "{consolidation_groups}",
        parts.join("\n\n")
    ).replace("{max_groups}", String(maxGroups));
}

// ════════════════════════════════════════════════════════════════
// MemoryUpdater 类
// ════════════════════════════════════════════════════════════════

export class MemoryUpdater {
    private modelName?: string;

    constructor(modelName?: string) {
        this.modelName = modelName;
    }

    private _resolveModelName(): string | undefined {
        const config = getAppConfig();
        return this.modelName || config.memory?.model_name || undefined;
    }

    private _buildCorrectionHint(
        correctionDetected: boolean,
        reinforcementDetected: boolean
    ): string {
        const hints: string[] = [];
        if (correctionDetected) {
            hints.push(
                "IMPORTANT: Explicit correction signals were detected in this conversation. " +
                "Pay special attention to what the agent got wrong, what the user corrected, " +
                "and record the correct approach as a fact with category " +
                '"correction" and confidence >= 0.95 when appropriate.'
            );
        }
        if (reinforcementDetected) {
            hints.push(
                "IMPORTANT: Positive reinforcement signals were detected in this conversation. " +
                "The user explicitly confirmed the agent's approach was correct or helpful. " +
                "Record the confirmed approach, style, or preference as a fact with category " +
                '"preference" or "behavior" and confidence >= 0.9 when appropriate.'
            );
        }
        return hints.join("\n");
    }

    async _prepareUpdatePrompt(
        messages: Array<{ type: string; content: unknown }>,
        agentName?: string,
        correctionDetected: boolean = false,
        reinforcementDetected: boolean = false,
        userId?: string
    ): Promise<{ currentMemory: Record<string, unknown>; prompt: string } | null> {
        const config = getAppConfig();
        if (!config.memory?.enabled || !messages) return null;

        const storage = getMemoryStorage();
        const currentMemory = await storage.load(agentName, userId);
        const conversationText = formatConversationForUpdate(messages);
        if (!conversationText.trim()) return null;

        const correctionHint = this._buildCorrectionHint(
            correctionDetected,
            reinforcementDetected
        );

        let stalenessSection = "";
        if (config.memory?.staleness_review_enabled) {
            const staleCandidates = _selectStaleCandidates(
                currentMemory,
                config.memory
            );
            if (
                staleCandidates.length >= (config.memory.staleness_min_candidates || 3)
            ) {
                stalenessSection = _buildStalenessSection(
                    staleCandidates,
                    config.memory.staleness_age_days || 90
                );
            }
        }

        let consolidationSection = "";
        if (config.memory?.consolidation_enabled) {
            const consolidationCandidates = _selectConsolidationCandidates(
                currentMemory,
                config.memory
            );
            if (Object.keys(consolidationCandidates).length > 0) {
                consolidationSection = _buildConsolidationSection(
                    consolidationCandidates,
                    config.memory.consolidation_max_groups_per_cycle || 3,
                    config.memory.consolidation_max_sources || 8
                );
            }
        }

        const escapedMemory = JSON.stringify(
            _escapeMemoryForPrompt(currentMemory),
            null,
            2
        );

        const prompt = MEMORY_UPDATE_PROMPT.replace(
            "{current_memory}",
            escapedMemory
        )
            .replace("{conversation}", conversationText)
            .replace("{correction_hint}", correctionHint)
            .replace("{staleness_review_section}", stalenessSection)
            .replace("{consolidation_section}", consolidationSection);

        return { currentMemory, prompt };
    }

    async _finalizeUpdate(
        currentMemory: Record<string, unknown>,
        responseContent: unknown,
        agentName?: string,
        userId?: string
    ): Promise<boolean> {
        const updateData = _parseMemoryUpdateResponse(responseContent);
        if (Object.keys(updateData).length === 0) return false;

        const normalized = _normalizeMemoryUpdateData(updateData);
        if (Object.keys(normalized).length === 0) return false;

        const updated = _applyUpdates(currentMemory, normalized);
        const cleaned = _stripUploadMentionsFromMemory(updated);

        const storage = getMemoryStorage();
        await storage.save(cleaned, agentName, userId);
        return true;
    }

    async update(
        messages: Array<{ type: string; content: unknown }>,
        agentName?: string,
        userId?: string
    ): Promise<boolean> {
        const prepared = await this._prepareUpdatePrompt(
            messages,
            agentName,
            false,
            false,
            userId
        );
        if (!prepared) return false;

        const modelName = this._resolveModelName();
        const model = await createChatModel(modelName);
        const response = await model.invoke(prepared.prompt);

        const content = response.content;
        return await this._finalizeUpdate(
            prepared.currentMemory,
            content,
            agentName,
            userId
        );
    }
}

// ════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════

export async function updateMemoryFromConversation(
    messages: Array<{ type: string; content: unknown }>,
    agentName?: string,
    userId?: string,
    modelName?: string
): Promise<Record<string, unknown>> {
    const updater = new MemoryUpdater(modelName);
    await updater.update(messages, agentName, userId);
    const storage = getMemoryStorage();
    return await storage.load(agentName, userId);
}
