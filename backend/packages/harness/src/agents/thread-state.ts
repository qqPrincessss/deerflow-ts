/**
 * ThreadState — Agent 的完整状态定义。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/thread_state.py
 *
 * 这是 LangGraph 图在节点之间传递的数据。
 * 每个字段有一个"合并函数"（reducer），处理并行写入时的冲突。
 *
 * 为什么需要合并函数？
 * LangGraph 是并行的。Agent 可能同时调用 3 个工具，3 个工具都往同一个字段写数据。
 * 如果不合并，后写的会把先写的覆盖掉。
 */

// ─── 子类型定义 ──────────────────────────────────────────────────

/** 沙箱状态 */
export interface SandboxState {
    sandbox_id?: string | null;
}

/** 线程数据目录路径 */
export interface ThreadDataState {
    workspace_path?: string;
    uploads_path?: string;
    outputs_path?: string;
}

/** 已查看图片的元数据（不含 base64，按需从磁盘读取） */
export interface ViewedImageData {
    mime_type: string;
    size: number;
    actual_path: string;
}

/** 延迟工具提升状态 */
export interface PromotedTools {
    catalog_hash: string;
    names: string[];
}

/** 子代理委托记录 */
export interface DelegationEntry {
    id: string;
    run_id?: string;
    description: string;
    subagent_type: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
    result_brief?: string;
    result_sha256?: string;
    result_ref?: string;
    stop_reason?: "token_capped" | "turn_capped" | "loop_capped";
    created_at: string;
}

/** 已加载的技能引用 */
export interface SkillEntry {
    name: string;
    path: string;
    description: string;
    loaded_at: number;
}

/** 目标状态 */
export interface GoalState {
    condition: string;
    status: "active" | "satisfied" | "cleared";
    last_evaluation?: {
        blocker: string;
        reason: string;
        evidence_summary: string;
        outcome: string;
        stand_down_reason?: string;
    };
}

// ─── 合并函数（Reducers） ──────────────────────────────────────────────────

/**
 * 合并沙箱状态 — 幂等写入。
 *
 * 逻辑：相同值可以，不同值报错。
 * 为什么？一个线程只能有一个沙箱，不同 ID 说明有 bug。
 */
export function mergeSandbox(existing: SandboxState | null, update: SandboxState | null): SandboxState | null {
    if (update === null) return existing;
    if (existing === null) return update;
    if (existing.sandbox_id === update.sandbox_id) return existing;
    throw new Error(`Conflicting sandbox state: ${existing.sandbox_id} != ${update.sandbox_id}`);
}

/**
 * 合并产出文件列表 — 去重合并。
 *
 * 逻辑：拼起来，去掉重复的。
 * 为什么？多个工具可能产出同一个文件。
 */
export function mergeArtifacts(existing: string[], update: string[]): string[] {
    return [...new Set(existing.concat(update))];
}

/**
 * 合并待办事项 — 后写覆盖。
 *
 * 逻辑：新值有就用新值，新值没有就保留旧的。
 */
export function mergeTodos(existing: unknown[] | null, update: unknown[] | null): unknown[] | null {
    if (update === null) return existing;
    return update;
}

/**
 * 合并目标状态 — 后写覆盖。
 *
 * 逻辑：新值有就用新值，新值没有就保留旧的。
 */
export function mergeGoal(existing: GoalState | null, update: GoalState | null): GoalState | null {
    if (update === null) return existing;
    return update;
}

/**
 * 合并已查看图片 — 合并字典，空字典=清空。
 *
 * 逻辑：
 * - 新值有就合并（新值覆盖同 key 的旧值）
 * - 新值是空字典 {} → 清空所有（允许中间件重置状态）
 */
export function mergeViewedImages(
    existing: Record<string, ViewedImageData>,
    update: Record<string, ViewedImageData>
): Record<string, ViewedImageData> {
    if (Object.keys(update).length === 0) return {};
    return { ...existing, ...update };
}

/**
 * 合并延迟工具提升 — 按 catalog_hash 合并。
 *
 * 逻辑：
 * - catalog_hash 变了 → 整体替换（防止旧工具名暴露给新目录）
 * - catalog_hash 相同 → 合并 name 列表，去重
 */
export function mergePromoted(existing: PromotedTools | null, update: PromotedTools | null): PromotedTools | null {
    if (update === null) return existing;
    if (existing === null || existing.catalog_hash !== update.catalog_hash) {
        return {
            catalog_hash: update.catalog_hash,
            names: [...new Set(update.names)],
        };
    }
    return {
        catalog_hash: existing.catalog_hash,
        names: [...new Set([...existing.names, ...update.names])],
    };
}

/** 终端状态集合（不能再变的状态） */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

/** 委托账本最大条目数 */
const DELEGATION_LEDGER_MAX_ENTRIES = 50;

/**
 * 合并子代理委托账本 — 按 ID 合并，终端状态不降级。
 *
 * 逻辑：
 * - 按 ID 去重（同 ID 取最新的）
 * - 终端状态（completed/failed/cancelled）不被非终端状态覆盖
 * - 超过 50 条只保留最新的
 * - 保留 created_at（首次创建时间）
 * - 保留 run_id（首次记录的）
 */
export function mergeDelegations(existing: DelegationEntry[], update: DelegationEntry[]): DelegationEntry[] {
    if (update.length === 0) return existing;

    const byId = new Map<string, DelegationEntry>();
    const order: string[] = [];

    for (let entry of [...existing, ...update]) {
        const prev = byId.get(entry.id);

        // 终端状态不被非终端状态覆盖
        if (prev && TERMINAL_STATUSES.has(prev.status) && !TERMINAL_STATUSES.has(entry.status)) {
            continue;
        }

        if (!byId.has(entry.id)) {
            order.push(entry.id);
        } else if (prev?.created_at) {
            // 保留首次创建时间
            entry = { ...entry, created_at: prev.created_at };
            // 保留首次记录的 run_id
            if (prev.run_id && !entry.run_id) {
                entry = { ...entry, run_id: prev.run_id };
            }
        }

        byId.set(entry.id, entry);
    }

    let merged = order.map((id) => byId.get(id)!);

    // 超过限制只保留最新的
    if (merged.length > DELEGATION_LEDGER_MAX_ENTRIES) {
        merged = merged.slice(-DELEGATION_LEDGER_MAX_ENTRIES);
    }

    return merged;
}

/** 技能上下文最大条目数 */
const SKILL_CONTEXT_MAX_ENTRIES = 8;

/** 技能描述最大字符数 */
const SKILL_DESCRIPTION_MAX_CHARS = 500;

/**
 * 标准化技能条目。
 */
function normalizeSkillEntry(entry: Partial<SkillEntry>): SkillEntry {
    const desc = entry.description;
    return {
        name: entry.name ?? "",
        path: entry.path ?? "",
        description: typeof desc === "string"
            ? desc.split(/\s+/).join(" ").slice(0, SKILL_DESCRIPTION_MAX_CHARS)
            : "",
        loaded_at: typeof entry.loaded_at === "number" ? entry.loaded_at : 0,
    };
}

/**
 * 合并技能上下文 — 按 path 去重，保留最近读取的。
 *
 * 逻辑：
 * - 按 path 去重（同 path 取最新的）
 * - 最多保留 8 个
 */
export function mergeSkillContext(existing: SkillEntry[], update: SkillEntry[]): SkillEntry[] {
    const normalizedExisting = existing.map(normalizeSkillEntry);
    const normalizedUpdate = update.map(normalizeSkillEntry);

    if (normalizedUpdate.length === 0) return normalizedExisting;

    const byPath = new Map<string, SkillEntry>();
    const order: string[] = [];

    for (const entry of normalizedExisting) {
        if (!byPath.has(entry.path)) {
            order.push(entry.path);
        }
        byPath.set(entry.path, entry);
    }

    for (const entry of normalizedUpdate) {
        const idx = order.indexOf(entry.path);
        if (idx !== -1) order.splice(idx, 1);
        order.push(entry.path);
        byPath.set(entry.path, entry);
    }

    let merged = order.map((p) => byPath.get(p)!);

    // 超过限制只保留最新的
    if (merged.length > SKILL_CONTEXT_MAX_ENTRIES) {
        merged = merged.slice(-SKILL_CONTEXT_MAX_ENTRIES);
    }

    return merged;
}

/**
 * 合并标题 — 后写覆盖。
 *
 * 逻辑：新值有就用新值，新值没有就保留旧的。
 */
export function mergeTitle(existing: string | null, update: string | null): string | null {
    if (update === null) return existing;
    return update;
}

/**
 * 合并摘要 — 后写覆盖。
 *
 * 逻辑：新值有就用新值，新值没有就保留旧的。
 */
export function mergeSummaryText(existing: string | null, update: string | null): string | null {
    if (update === null) return existing;
    return update;
}
