/**
 * 技能目录 — 运行时延迟技能发现。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/catalog.py
 *
 * AI 通过 <skill_index> 看到技能名，但需要通过 describe_skill 才能读取具体内容。
 * 这个目录支持三种查询：
 *   select:name1,name2 — 按名称精确选择
 *   +required query    — 要求名称中包含 required，按 query 排序
 *   自由文本           — 正则匹配名称+描述
 */

import { type Skill } from "./types.js";

const MAX_RESULTS = 5;

// ════════════════════════════════════════════════════════════════════════════════
// 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _compileCatalogRegex(pattern: string): RegExp {
    try {
        return new RegExp(pattern, "i");
    } catch {
        return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
}

function _catalogRegexScore(pattern: RegExp, s: Skill): number {
    const text = `${s.name} ${s.description ?? ""}`;
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
}

// ════════════════════════════════════════════════════════════════════════════════
// SkillCatalog
// ════════════════════════════════════════════════════════════════════════════════

export class SkillCatalog {
    private _skills: Skill[];

    constructor(skills: Skill[]) {
        this._skills = skills;
    }

    get names(): Set<string> {
        return new Set(this._skills.map((s) => s.name));
    }

    get all(): Skill[] {
        return this._skills;
    }

    /**
     * 搜索技能。
     *
     * 三种查询模式：
     *   1. "select:data-analysis,deep-research" — 按名称精确选择
     *   2. "+podcast gen" — 名称包含 podcast，按 gen 排序
     *   3. "chart visualization" — 正则匹配名称+描述
     */
    search(query: string): Skill[] {
        query = query.trim();
        if (!query) return [];

        // ── 精确选择 ──
        if (query.startsWith("select:")) {
            const wanted = new Set(query.slice(7).split(",").map((n) => n.trim()));
            return this._skills.filter((s) => wanted.has(s.name));
        }

        // ── 必要前缀搜索 ──
        if (query.startsWith("+")) {
            const rest = query.slice(1).trim();
            const spaceIdx = rest.indexOf(" ");
            const required = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
            const searchTerm = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();

            if (!required) return [];

            let candidates = this._skills.filter((s) =>
                s.name.toLowerCase().includes(required.toLowerCase()),
            );

            if (searchTerm) {
                const pattern = _compileCatalogRegex(searchTerm);
                candidates.sort((a, b) => _catalogRegexScore(pattern, b) - _catalogRegexScore(pattern, a));
            }

            return candidates.slice(0, MAX_RESULTS);
        }

        // ── 自由文本正则搜索 ──
        const regex = _compileCatalogRegex(query);
        const scored: Array<[number, Skill]> = [];

        for (const s of this._skills) {
            const searchable = `${s.name} ${s.description ?? ""}`;
            if (regex.test(searchable)) {
                const hasNameMatch = regex.test(s.name);
                scored.push([hasNameMatch ? 2 : 1, s]);
            }
        }

        scored.sort((a, b) => b[0] - a[0]);
        return scored.slice(0, MAX_RESULTS).map(([, s]) => s);
    }
}
