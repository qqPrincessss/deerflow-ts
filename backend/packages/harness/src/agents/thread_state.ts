import { type GoalState } from "./goal_state.js";

export interface SandboxState {
    sandbox_id?:string|null
}
//这是线程的目录路径
export interface ThreadDataState{
    workspace_path?:string | null,
    uploads_path?:string|null,
    outputs_path?:string|null
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
    status: string;
    result_brief?: string;
    result_sha256?: string;
    result_ref?: string;
    stop_reason?: string;
    created_at: string;
}

/** 已加载的技能引用 */
export interface SkillEntry {
    name: string;
    path: string;
    description: string;
    loaded_at: number;
}

//合并沙箱函数
export function mergeSandbox(existing:SandboxState | null, updated:SandboxState|null):SandboxState | null{
    if(existing === null){
        return updated;
    }else if(updated === null){
        return existing;
    }
    else if(existing.sandbox_id === updated?.sandbox_id){
        return existing;
    }else{
        throw new Error(`Conflicting sandbox state updates: ${existing.sandbox_id} != ${updated.sandbox_id}`)
    }
}

/**
 * 合并产出文件列表 — 去重合并。
 *
 * 为什么需要？Agent 可能同时执行多个工具，每个工具都往 artifacts 里加文件。
 * 不合并的话，后写的会覆盖先写的。
 *
 * 逻辑：
 * 1. existing 是 null → 返回 new 或空列表
 * 2. new 是 null → 返回 existing
 * 3. 否则 → 拼起来，去重，保留顺序
 */
export function mergeArtifacts(existing: string[] | null, update: string[] | null): string[] {
    if (existing === null) {
        return update ?? [];
    }
    if (update === null) {
        return existing;
    }
    return [...new Set(existing.concat(update))];
}

/**
 * 合并已查看图片 — 合并字典，空字典=清空。
 *
 * 为什么需要？多个图片查看操作要合并。
 * 特殊操作：空字典 {} 表示"清空所有图片"。
 *
 * 逻辑：
 * 1. existing 是 null → 返回 new 或空字典
 * 2. new 是 null → 返回 existing
 * 3. new 是空字典 → 清空所有
 * 4. 否则 → 合并字典，新值覆盖同 key 的旧值
 */
export function mergeViewedImages(
    existing: Record<string, ViewedImageData>,
    update: Record<string, ViewedImageData>
): Record<string, ViewedImageData> {
    if (Object.keys(existing).length === 0 && Object.keys(update).length === 0) {
        return {};
    }
    if (Object.keys(update).length === 0) {
        return {};
    }
    return { ...existing, ...update };
}

/**
 * 合并待办事项 — 后写覆盖。
 *
 * 逻辑：new 是 null 就保留 existing，否则用 new。
 */
export function mergeTodos(existing: unknown[] | null, update: unknown[] | null): unknown[] | null {
    if (update === null) return existing;
    return update;
}

/**
 * 合并目标状态 — 后写覆盖。
 *
 * 逻辑：new 是 null 就保留 existing，否则用 new。
 */
export function mergeGoal(existing: GoalState | null, update: GoalState | null): GoalState | null {
    if (update === null) return existing;
    return update;
}

/**
 * 合并延迟工具提升 — 按 catalog_hash 合并。
 *
 * 逻辑：
 * 1. new 是 null/空 → 保留 existing
 * 2. catalog_hash 变了 → 整体替换
 * 3. catalog_hash 相同 → 合并 names，去重
 */
export function mergePromoted(existing: PromotedTools | null, update: PromotedTools | null): PromotedTools | null {
    if (!update) return existing;
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
 * 1. update 是空 → 保留 existing
 * 2. 拼在一起，按 id 去重（同 id 取最新的）
 * 3. 终端状态（completed/failed/cancelled/timed_out）不被非终端状态覆盖
 * 4. 保留 created_at（首次创建时间）
 * 5. 保留 run_id（首次记录的）
 * 6. 超过 50 条只保留最新的
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

        // 保留 created_at 和 run_id
        if (prev?.created_at) {
            entry = { ...entry, created_at: prev.created_at };
            if (prev.run_id && !entry.run_id) {
                entry = { ...entry, run_id: prev.run_id };
            }
        }

        if (!byId.has(entry.id)) {
            order.push(entry.id);
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
 * 1. new 是空 → 保留 existing（标准化后）
 * 2. 按 path 去重（同 path 取最新的）
 * 3. 超过 8 条只保留最新的
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

// ─── ThreadState 主接口（12 个字段） ──────────────────────────────────────────────────

/**
 * ThreadState — Agent 的完整状态定义。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/thread_state.py
 *
 * 这是 LangGraph 图在节点之间传递的数据。
 * 每个字段有一个"合并函数"（reducer），处理并行写入时的冲突。
 *
 * 原项目用 Annotated[T, reducer] 语法把类型和合并函数绑定。
 * TypeScript 没有 Annotated，我们把合并函数单独导出，
 * 在组装 LangGraph 图时手动绑定。
 */
export interface ThreadState {
    /** 沙箱状态（幂等写入，冲突报错） */
    sandbox?: SandboxState | null;

    /** 线程目录路径（后写覆盖） */
    thread_data?: ThreadDataState | null;

    /** 对话标题（后写覆盖） */
    title?: string | null;

    /** 产出文件列表（去重合并） */
    artifacts: string[];

    /** 待办事项（后写覆盖） */
    todos?: unknown[] | null;

    /** 目标状态（后写覆盖） */
    goal?: GoalState | null;

    /** 上传文件元数据（后写覆盖） */
    uploaded_files?: Record<string, unknown>[] | null;

    /** 已查看图片元数据（合并，空字典=清空） */
    viewed_images: Record<string, ViewedImageData>;

    /** 延迟工具提升（按 catalog_hash 合并） */
    promoted?: PromotedTools | null;

    /** 子代理委托账本（按 ID 合并，终端状态不降级） */
    delegations: DelegationEntry[];

    /** 已加载的技能引用（按 path 去重） */
    skill_context: SkillEntry[];

    /** 压缩后的摘要（后写覆盖） */
    summary_text?: string | null;
}

