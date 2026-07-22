/**
 * 沙箱内搜索工具 — glob 和 grep 实现。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/search.py
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";

// ════════════════════════════════════════════════════════════════
// 忽略配置
// ════════════════════════════════════════════════════════════════

const IGNORE_PATTERNS = [
    ".git", ".svn", ".hg", ".bzr", "node_modules", "__pycache__",
    ".venv", "venv", ".env", "env", ".tox", ".nox", ".eggs",
    "*.egg-info", "site-packages", "dist", "build", ".next", ".nuxt",
    ".output", ".turbo", "target", "out", ".idea", ".vscode",
    "*.swp", "*.swo", "*~", ".project", ".classpath", ".settings",
    ".DS_Store", "Thumbs.db", "desktop.ini", "*.lnk", "*.log",
    "*.tmp", "*.temp", ".upload-*.part", "*.bak", "*.cache", ".cache",
    "logs", ".coverage", "coverage", ".nyc_output", "htmlcov",
    ".pytest_cache", ".mypy_cache", ".ruff_cache",
];

const DEFAULT_MAX_FILE_SIZE = 1_000_000;
const DEFAULT_LINE_SUMMARY_LENGTH = 200;

/** 精确匹配的忽略名称 */
const _exactIgnoreNames = new Set(
    IGNORE_PATTERNS.filter((p) => !p.includes("*") && !p.includes("?") && !p.includes("["))
);

/** 通配符忽略模式列表 */
const _globIgnorePatterns = IGNORE_PATTERNS.filter((p) => p.includes("*") || p.includes("?") || p.includes("["));

/** 通配符转正则 */
function globToRegExp(pattern: string): RegExp {
    let regexStr = "";
    for (const ch of pattern) {
        if (ch === "*") regexStr += ".*";
        else if (ch === "?") regexStr += ".";
        else regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${regexStr}$`, "i");
}

/** 编译忽略正则 */
const _globIgnoreRegexes = _globIgnorePatterns.map(globToRegExp);

import { type GrepMatch } from "./sandbox.js";

// ════════════════════════════════════════════════════════════════
// 工具函数
// ════════════════════════════════════════════════════════════════

function shouldIgnoreName(name: string): boolean {
    const normalized = name.toLowerCase();
    if (_exactIgnoreNames.has(normalized)) return true;
    return _globIgnoreRegexes.some((re) => re.test(normalized));
}

function shouldIgnorePath(path: string): boolean {
    return path.replace(/\\/g, "/").split("/").some((seg) => seg && shouldIgnoreName(seg));
}

function pathMatches(pattern: string, relPath: string): boolean {
    if (pattern.startsWith("**/")) {
        const suffix = pattern.slice(3);
        return relPath.endsWith(suffix) || relPath.includes("/" + suffix);
    }
    const re = globToRegExp(pattern);
    return re.test(relPath);
}

function truncateLine(line: string, maxChars: number = DEFAULT_LINE_SUMMARY_LENGTH): string {
    line = line.replace(/[\n\r]+$/, "");
    if (line.length <= maxChars) return line;
    return line.slice(0, maxChars - 3) + "...";
}

function isBinaryFile(filePath: string, sampleSize: number = 8192): boolean {
    try {
        const fd = readFileSync(filePath);
        const sample = fd.slice(0, sampleSize);
        return sample.includes(0);
    } catch {
        return true;
    }
}

// ════════════════════════════════════════════════════════════════
// Glob 匹配
// ════════════════════════════════════════════════════════════════

export function findGlobMatches(
    root: string,
    pattern: string,
    options?: { include_dirs?: boolean; max_results?: number }
): [string[], boolean] {
    const { include_dirs = false, max_results = 200 } = options ?? {};
    const matches: string[] = [];
    let truncated = false;

    function walk(dir: string, depth: number): void {
        let entries: string[];
        try {
            entries = readdirSync(dir, { withFileTypes: true })
                .filter((e) => !shouldIgnoreName(e.name))
                .map((e) => e.name);
        } catch {
            return;
        }

        const relDir = relative(root, dir).replace(/\\/g, "/");

        for (const name of entries) {
            const relPath = relDir ? `${relDir}/${name}` : name;
            const fullPath = join(dir, name);

            let isDir: boolean;
            try {
                isDir = statSync(fullPath).isDirectory();
            } catch {
                continue;
            }

            if (isDir) {
                if (include_dirs && pathMatches(pattern, relPath)) {
                    matches.push(fullPath);
                    if (matches.length >= max_results) {
                        truncated = true;
                        return;
                    }
                }
                walk(fullPath, depth + 1);
                if (truncated) return;
            } else {
                if (pathMatches(pattern, relPath)) {
                    matches.push(fullPath);
                    if (matches.length >= max_results) {
                        truncated = true;
                        return;
                    }
                }
            }
        }
    }

    walk(resolve(root), 0);
    return [matches, truncated];
}

// ════════════════════════════════════════════════════════════════
// Grep 搜索
// ════════════════════════════════════════════════════════════════

export function findGrepMatches(
    root: string,
    pattern: string,
    options?: {
        glob_pattern?: string;
        literal?: boolean;
        case_sensitive?: boolean;
        max_results?: number;
        max_file_size?: number;
        line_summary_length?: number;
    }
): [GrepMatch[], boolean] {
    const {
        glob_pattern,
        literal = false,
        case_sensitive = false,
        max_results = 100,
        max_file_size = DEFAULT_MAX_FILE_SIZE,
        line_summary_length = DEFAULT_LINE_SUMMARY_LENGTH,
    } = options ?? {};

    const matches: GrepMatch[] = [];
    let truncated = false;
    const resolvedRoot = resolve(root);

    const regexSource = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    const flags = case_sensitive ? "g" : "gi";
    let regex: RegExp;
    try {
        regex = new RegExp(regexSource, flags);
    } catch {
        return [matches, truncated];
    }

    const maxLineChars = line_summary_length * 10;

    function walk(dir: string): void {
        let entries: string[];
        try {
            entries = readdirSync(dir, { withFileTypes: true })
                .filter((e) => !shouldIgnoreName(e.name))
                .map((e) => e.name);
        } catch {
            return;
        }

        for (const name of entries) {
            const fullPath = join(dir, name);
            let stat;
            try {
                stat = statSync(fullPath);
            } catch {
                continue;
            }

            if (stat.isDirectory()) {
                walk(fullPath);
                continue;
            }

            const relDir = relative(resolvedRoot, dir).replace(/\\/g, "/");
            const relPath = relDir ? `${relDir}/${name}` : name;

            if (glob_pattern && !pathMatches(glob_pattern, relPath)) continue;

            try {
                if (stat.size > max_file_size || isBinaryFile(fullPath)) continue;

                const content = readFileSync(fullPath, "utf-8");
                const lines = content.split("\n");

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.length > maxLineChars) continue;
                    regex.lastIndex = 0;
                    const match = regex.exec(line);
                    if (match) {
                        const matchIdx = match.index;
                        matches.push({
                            path: fullPath,
                            line_number: i + 1,
                            line: truncateLine(line, line_summary_length),
                            match_start: matchIdx,
                            match_end: matchIdx + (match[0]?.length ?? 0),
                        });
                        if (matches.length >= max_results) {
                            truncated = true;
                            return;
                        }
                    }
                }
            } catch {
                continue;
            }
            if (truncated) return;
        }
    }

    walk(resolvedRoot);
    return [matches, truncated];
}
