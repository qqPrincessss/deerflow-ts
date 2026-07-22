/**
 * 本地技能存储 — 本地文件系统实现的 SkillStorage。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/storage/local_skill_storage.py
 * 和 user_scoped_skill_storage.py。
 *
 * 功能：
 * - 扫描 skills/public/、custom/、legacy/ 目录下的 SKILL.md
 * - 原子写入（temp file + replace）
 * - 历史记录（JSONL）
 * - Per-user 自定义技能隔离
 * - Legacy 技能回退
 */

import {
    existsSync, readFileSync, readdirSync, writeFileSync,
    mkdirSync, rmSync, renameSync, appendFileSync, openSync,
    closeSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { DEFAULT_SKILLS_CONTAINER_PATH } from "../../constants.js";
import { type Skill, SkillCategory, SKILL_MD_FILE } from "../types.js";
import { type SkillStorage } from "../storage.js";
import { parseSkillFile } from "../parser.js";

// ════════════════════════════════════════════════════════════════════════════════
// 基类
// ════════════════════════════════════════════════════════════════════════════════

export class LocalSkillStorage implements SkillStorage {
    protected _hostRoot: string;
    protected _containerPath: string;
    protected _appConfig: unknown;

    constructor(hostPath?: string, containerPath?: string, appConfig?: unknown) {
        this._hostRoot = hostPath ?? (process.env.DEER_FLOW_HOME || ".deer-flow");
        this._containerPath = containerPath ?? DEFAULT_SKILLS_CONTAINER_PATH;
        this._appConfig = appConfig ?? null;
    }

    getSkillsRootPath(): string {
        return this._hostRoot;
    }

    getContainerRoot(): string {
        return this._containerPath;
    }

    // ── 加载技能 ──────────────────────────────────────────────────

    loadSkills(options?: { enabled_only?: boolean }): Skill[] {
        const skillsByName = new Map<string, Skill>();

        if (!existsSync(this._hostRoot)) return [];

        for (const cat of [SkillCategory.PUBLIC, SkillCategory.CUSTOM, SkillCategory.LEGACY]) {
            const catPath = join(this._hostRoot, cat);
            if (!existsSync(catPath)) continue;

            const entries = readdirSync(catPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                const mdPath = join(catPath, entry.name, SKILL_MD_FILE);
                if (!existsSync(mdPath)) continue;

                const relPath = relative(catPath, dirname(mdPath));
                const skill = parseSkillFile(mdPath, cat, relPath);
                if (skill) {
                    skillsByName.set(skill.name, skill);
                }
            }
        }

        let skills = Array.from(skillsByName.values());

        // 合并启用状态（从 extensions_config.json 读取）
        skills = this._mergeEnabledStates(skills);

        if (options?.enabled_only) {
            skills = skills.filter((s) => s.enabled);
        }

        skills.sort((a, b) => a.name.localeCompare(b.name));
        return skills;
    }

    /**
     * 从 extensions_config.json 读取技能启用状态。
     * 文件格式：{ "skills": { "skill-name": { "enabled": true }, ... } }
     */
    protected _mergeEnabledStates(skills: Skill[]): Skill[] {
        try {
            const configPath = join(this._hostRoot, "extensions_config.json");
            if (!existsSync(configPath)) return skills;

            const raw = readFileSync(configPath, "utf-8");
            const config = JSON.parse(raw);
            const skillStates = config.skills as Record<string, { enabled?: boolean }> | undefined;
            if (!skillStates) return skills;

            return skills.map((s) => {
                const state = skillStates[s.name];
                if (state !== undefined) {
                    return { ...s, enabled: state.enabled !== false };
                }
                // CUSTOM 技能默认启用
                if (s.category === SkillCategory.CUSTOM) {
                    return { ...s, enabled: true };
                }
                return s;
            });
        } catch {
            return skills;
        }
    }

    // ── 路径辅助 ──────────────────────────────────────────────────

    validateSkillFilePath(skillFile: string): string {
        const resolved = resolve(skillFile);
        const root = resolve(this._hostRoot);
        if (!resolved.startsWith(root)) {
            throw new Error("Resolved skill file must stay within the configured skills root.");
        }
        return resolved;
    }

    getCustomSkillDir(name: string): string {
        return join(this._hostRoot, SkillCategory.CUSTOM, name);
    }

    getCustomSkillFile(name: string): string {
        return join(this.getCustomSkillDir(name), SKILL_MD_FILE);
    }

    getSkillHistoryFile(name: string): string {
        return join(this._hostRoot, SkillCategory.CUSTOM, ".history", `${name}.jsonl`);
    }

    customSkillExists(name: string): boolean {
        return existsSync(this.getCustomSkillFile(name));
    }

    publicSkillExists(name: string): boolean {
        return existsSync(join(this._hostRoot, SkillCategory.PUBLIC, name, SKILL_MD_FILE));
    }

    // ── 读写技能 ──────────────────────────────────────────────────

    readCustomSkill(name: string): string {
        const file = this.getCustomSkillFile(name);
        if (!existsSync(file)) throw new Error(`Custom skill '${name}' not found.`);
        return readFileSync(file, "utf-8");
    }

    /**
     * 原子写入技能文件。
     * 先写入临时文件，再 rename 替换目标文件，防止断电导致文件损坏。
     */
    writeCustomSkill(name: string, content: string): void {
        const dir = this.getCustomSkillDir(name);
        mkdirSync(dir, { recursive: true });

        const target = join(dir, SKILL_MD_FILE);
        // 临时文件（同一目录，保证原子 rename）
        const tmp = join(dir, `.${name}.tmp`);
        try {
            writeFileSync(tmp, content, "utf-8");
            renameSync(tmp, target);
        } catch (error) {
            // 清理临时文件
            try { if (existsSync(tmp)) rmSync(tmp); } catch { /* ignore */ }
            throw error;
        }
    }

    deleteCustomSkill(name: string): void {
        const dir = this.getCustomSkillDir(name);
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    // ── 历史记录 ──────────────────────────────────────────────────

    appendHistory(name: string, record: Record<string, unknown>): void {
        const payload = { ts: new Date().toISOString(), ...record };
        const historyFile = this.getSkillHistoryFile(name);
        mkdirSync(dirname(historyFile), { recursive: true });
        appendFileSync(historyFile, JSON.stringify(payload) + "\n", "utf-8");
    }

    readHistory(name: string): Record<string, unknown>[] {
        const historyFile = this.getSkillHistoryFile(name);
        if (!existsSync(historyFile)) return [];

        const records: Record<string, unknown>[] = [];
        for (const line of readFileSync(historyFile, "utf-8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                records.push(JSON.parse(trimmed));
            } catch { /* skip malformed lines */ }
        }
        return records;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 用户隔离存储
// ════════════════════════════════════════════════════════════════════════════════

export class UserScopedSkillStorage extends LocalSkillStorage {
    private _userId: string;
    private _userCustomRoot: string;
    private _globalCustomRoot: string;
    private _userSkillsRoot: string;
    private _skillStatesFile: string;

    constructor(userId: string, hostPath?: string, containerPath?: string) {
        super(hostPath, containerPath);
        this._userId = userId.replace(/[^A-Za-z0-9_\-]/g, "_");
        this._userCustomRoot = join(this._hostRoot, "users", this._userId, "skills", "custom");
        this._globalCustomRoot = join(this._hostRoot, SkillCategory.CUSTOM);
        this._userSkillsRoot = join(this._hostRoot, "users", this._userId, "skills");
        this._skillStatesFile = join(this._userSkillsRoot, "_skill_states.json");
    }

    // ── Per-user 启用状态 ─────────────────────────────────────────

    private _readSkillStates(): Record<string, boolean> {
        if (!existsSync(this._skillStatesFile)) return {};
        try {
            const raw = readFileSync(this._skillStatesFile, "utf-8");
            const data = JSON.parse(raw);
            if (typeof data === "object" && data !== null) {
                const result: Record<string, boolean> = {};
                for (const [key, val] of Object.entries(data)) {
                    if (typeof val === "object" && val !== null) {
                        result[key] = (val as Record<string, unknown>).enabled !== false;
                    } else {
                        result[key] = val !== false;
                    }
                }
                return result;
            }
        } catch { /* ignore */ }
        return {};
    }

    private _writeSkillStates(states: Record<string, boolean>): void {
        mkdirSync(this._userSkillsRoot, { recursive: true });
        const tmp = join(this._userSkillsRoot, `.skill_states.tmp`);
        try {
            const data: Record<string, { enabled: boolean }> = {};
            for (const [name, enabled] of Object.entries(states)) {
                data[name] = { enabled };
            }
            writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
            renameSync(tmp, this._skillStatesFile);
        } catch {
            try { if (existsSync(tmp)) rmSync(tmp); } catch { /* ignore */ }
        }
    }

    // ── 加载技能（覆盖父类，加入 per-user 状态） ─────────────────

    loadSkills(options?: { enabled_only?: boolean }): Skill[] {
        const skillsByName = new Map<string, Skill>();

        // 公开技能（全局）
        const publicPath = join(this._hostRoot, SkillCategory.PUBLIC);
        if (existsSync(publicPath)) {
            for (const entry of readdirSync(publicPath, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                const mdPath = join(publicPath, entry.name, SKILL_MD_FILE);
                if (!existsSync(mdPath)) continue;
                const skill = parseSkillFile(mdPath, SkillCategory.PUBLIC, entry.name);
                if (skill) skillsByName.set(skill.name, skill);
            }
        }

        // 用户自定义技能（per-user）
        if (existsSync(this._userCustomRoot)) {
            for (const entry of readdirSync(this._userCustomRoot, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                const mdPath = join(this._userCustomRoot, entry.name, SKILL_MD_FILE);
                if (!existsSync(mdPath)) continue;
                const skill = parseSkillFile(mdPath, SkillCategory.CUSTOM, entry.name);
                if (skill) skillsByName.set(skill.name, skill);
            }
        }

        // Legacy 回退：用户没有自定义技能时，从全局 custom 读（标记 LEGACY）
        const hasUserSkills = existsSync(this._userCustomRoot) &&
            readdirSync(this._userCustomRoot).some((n) => !n.startsWith("."));
        if (!hasUserSkills && existsSync(this._globalCustomRoot)) {
            for (const entry of readdirSync(this._globalCustomRoot, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                if (skillsByName.has(entry.name)) continue;
                const mdPath = join(this._globalCustomRoot, entry.name, SKILL_MD_FILE);
                if (!existsSync(mdPath)) continue;
                const skill = parseSkillFile(mdPath, SkillCategory.LEGACY, entry.name);
                if (skill) skillsByName.set(skill.name, skill);
            }
        }

        let skills = Array.from(skillsByName.values());

        // PUBLIC 技能：从 extensions_config 读
        skills = this._mergeEnabledStates(skills);

        // CUSTOM/LEGACY 技能：从 per-user _skill_states.json 读
        const userStates = this._readSkillStates();
        skills = skills.map((s) => {
            if (s.category === SkillCategory.PUBLIC) return s; // 已由 _mergeEnabledStates 处理
            const state = userStates[s.name];
            if (state !== undefined) {
                return { ...s, enabled: state };
            }
            return { ...s, enabled: true }; // 默认启用
        });

        if (options?.enabled_only) {
            skills = skills.filter((s) => s.enabled);
        }

        skills.sort((a, b) => a.name.localeCompare(b.name));
        return skills;
    }

    getCustomSkillDir(name: string): string {
        return join(this._userCustomRoot, name);
    }

    getSkillHistoryFile(name: string): string {
        return join(this._userCustomRoot, ".history", `${name}.jsonl`);
    }

    /**
     * 获取技能的启用状态。
     */
    getSkillEnabledState(name: string): boolean {
        const states = this._readSkillStates();
        return states[name] !== false;
    }

    /**
     * 设置技能的启用状态。
     */
    setSkillEnabledState(name: string, enabled: boolean): void {
        const states = this._readSkillStates();
        states[name] = enabled;
        this._writeSkillStates(states);
    }
}
