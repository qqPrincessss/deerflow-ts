/**
 * 静态安全扫描 — 技能安装前的静态分析。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/security_static_scanner.py
 *
 * 对技能文件进行静态规则检查（不调用 LLM），检测：
 * - 危险函数调用
 * - 文件路径遍历
 * - 可疑网络请求
 * - 环境变量泄露
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getAppConfig } from "../config/app_config.js";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface StaticFinding {
    rule_id: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    message: string;
    file?: string;
    line?: number;
    evidence?: string;
    remediation?: string;
}

// ════════════════════════════════════════════════════════════════════════════════
// 异常
// ════════════════════════════════════════════════════════════════════════════════

export class StaticScannerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StaticScannerError";
    }
}

export class StaticScanBlockedError extends Error {
    findings: StaticFinding[];
    skillName: string | null;

    constructor(message: string, findings?: StaticFinding[], skillName?: string | null) {
        super(message);
        this.name = "StaticScanBlockedError";
        this.findings = findings ?? [];
        this.skillName = skillName ?? null;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 危险模式
// ════════════════════════════════════════════════════════════════════════════════

const _DANGEROUS_PATTERNS: Array<{
    rule_id: string;
    severity: "CRITICAL" | "HIGH" | "MEDIUM";
    patterns: RegExp[];
    message: string;
    remediation: string;
}> = [
    {
        rule_id: "inline-code-execution",
        severity: "HIGH",
        patterns: [
            /\beval\s*\(/i,
            /exec\s*\(/i,
            /\bsystem\s*\(/i,
            /\bpopen\s*\(/i,
            /\bsubprocess\./i,
        ],
        message: "Inline code execution detected",
        remediation: "Remove or sandbox the eval/exec call",
    },
    {
        rule_id: "file-path-traversal",
        severity: "HIGH",
        patterns: [
            /\.\.\//,
            /\.\.\\/,
            /path\.join\s*\([^)]*\.\./,
        ],
        message: "Path traversal detected",
        remediation: "Restrict file access to skill directory",
    },
    {
        rule_id: "network-request",
        severity: "MEDIUM",
        patterns: [
            /https?:\/\//,
            /\bcurl\s/,
            /\bwget\s/,
            /\bfetch\s*\(/i,
        ],
        message: "Network request detected",
        remediation: "Verify the URL is safe or restrict external access",
    },
    {
        rule_id: "env-variable-leak",
        severity: "MEDIUM",
        patterns: [
            /process\.env/i,
            /os\.environ/i,
            /\$ENV\b/i,
            /\$\{[A-Z_]+}/,
        ],
        message: "Environment variable access detected",
        remediation: "Ensure secrets are not exposed in skill content",
    },
    {
        rule_id: "prompt-injection-keyword",
        severity: "CRITICAL",
        patterns: [
            /ignore\s+(all\s+)?(previous|above)\s+(instructions|prompts|commands)/i,
            /you\s+(are\s+)?(now|are)\s+(a\s+)?(admin|administrator|root|superuser)/i,
            /override\s+(all\s+)?(restrictions|rules|constraints|protocols)/i,
            /forget\s+(all\s+)?(previous|above)\s+(instructions|rules)/i,
        ],
        message: "Prompt injection detected",
        remediation: "Remove override/ignore instructions",
    },
];

// ════════════════════════════════════════════════════════════════════════════════
// 扫描函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 检查技能扫描是否启用。
 */
export function skillScanEnabled(appConfig?: unknown): boolean {
    try {
        const config = appConfig ?? getAppConfig();
        const cfg = config as Record<string, unknown>;
        const skillEvolution = cfg.skill_evolution as Record<string, unknown> | undefined;
        return (skillEvolution?.moderation_model_name as string) !== undefined;
    } catch {
        return false;
    }
}

/**
 * 扫描单个文件内容。
 */
function _scanFileContent(content: string, filePath: string): StaticFinding[] {
    const findings: StaticFinding[] = [];
    const lines = content.split("\n");

    for (const rule of _DANGEROUS_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pattern of rule.patterns) {
                const match = line.match(pattern);
                if (match) {
                    findings.push({
                        rule_id: rule.rule_id,
                        severity: rule.severity,
                        message: rule.message,
                        file: filePath,
                        line: i + 1,
                        evidence: line.trim().slice(0, 200),
                        remediation: rule.remediation,
                    });
                    break;
                }
            }
        }
    }

    return findings;
}

/**
 * 扫描技能目录。
 */
export function scanSkillDir(
    skillDir: string,
    _options?: { app_config?: unknown },
): StaticFinding[] {
    const findings: StaticFinding[] = [];

    function walk(dir: string): void {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch { return; }

        for (const name of entries) {
            if (name.startsWith(".")) continue;
            const fullPath = join(dir, name);
            let stat;
            try { stat = statSync(fullPath); } catch { continue; }

            if (stat.isDirectory()) {
                walk(fullPath);
                continue;
            }

            const relPath = relative(skillDir, fullPath).replace(/\\/g, "/");

            // 只扫描文本文件
            const textExts = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".sh", ".py", ".js", ".ts", ".bash", ".ps1", ".php", ".rb", ".pl"]);
            const ext = "." + relPath.split(".").pop()?.toLowerCase();
            if (!textExts.has(ext) && !relPath.endsWith("SKILL.md")) continue;

            try {
                const content = readFileSync(fullPath, "utf-8");
                const fileFindings = _scanFileContent(content, relPath);
                findings.push(...fileFindings);
            } catch { /* 二进制文件跳过 */ }
        }
    }

    walk(skillDir);
    return findings;
}

/**
 * 执行静态扫描，发现 CRITICAL 级别问题时抛出异常。
 */
export function enforceStaticScan(
    skillDir: string,
    options?: { skill_name?: string; app_config?: unknown },
): StaticFinding[] {
    const findings = scanSkillDir(skillDir, options);
    const critical = findings.filter((f) => f.severity === "CRITICAL");

    if (critical.length > 0) {
        throw new StaticScanBlockedError(
            `Static security scan blocked unsafe skill: ${critical.map((f) => f.rule_id).join(", ")}`,
            critical,
            options?.skill_name ?? null,
        );
    }

    return findings;
}

/**
 * 扫描归档文件的预检（基于文件名，不解压）。
 */
export function scanArchivePreflight(
    archivePath: string,
    _options?: { app_config?: unknown },
): { blocked: boolean; findings: StaticFinding[] } {
    const findings: StaticFinding[] = [];
    const name = archivePath.split(/[/\\]/).pop() ?? "";

    if (!name.endsWith(".skill")) {
        findings.push({
            rule_id: "invalid-extension",
            severity: "HIGH",
            message: "Skill archive must have .skill extension",
            file: name,
            remediation: "Rename to .skill extension",
        });
    }

    return { blocked: findings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH"), findings };
}

/**
 * 格式化静态发现。
 */
export function formatStaticFindings(findings: StaticFinding[]): string {
    return findings
        .map((f) => `${f.severity}: ${f.message} at ${f.file ?? "<unknown>"}${f.line ? ":" + f.line : ""}`)
        .join("\n");
}
