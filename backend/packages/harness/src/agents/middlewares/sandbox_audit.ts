/**
 * 沙箱审计中间件 — bash 命令安全检查。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/sandbox_audit_middleware.py
 *
 * 对每条 bash 命令做三件事：
 *   1. 命令分类：高危（block）/ 中危（warn）/ 安全（pass）
 *   2. 审计日志：记录每条 bash 调用
 *   3. 阻断高危命令：返回错误消息，不执行
 */

// ════════════════════════════════════════════════════════════════════════════════
// 高危模式（block）
// ════════════════════════════════════════════════════════════════════════════════

const _HIGH_RISK_PATTERNS = [
    /rm\s+-[^\s]*r[^\s]*\s+(\/\*?|~\/?\*?|\/home\b|\/root\b)\s*$/,
    /dd\s+if=/,
    /mkfs/,
    /cat\s+\/etc\/shadow/,
    />+\s*\/etc\//,
    /\|\s*(ba)?sh\b/,                                    // pipe to sh/bash
    /[`$]\(?\s*(curl|wget|bash|sh|python|ruby|perl|base64)/,  // command substitution
    /base64\s+.*-d.*\|/,                                 // base64 decode piped to exec
    />+\s*(\/usr\/bin\/|\/bin\/|\/sbin\/)/,              // overwrite system binaries
    />+\s*~\/?\.(bashrc|profile|zshrc|bash_profile)/,    // overwrite shell startup
    /\/proc\/[^/]+\/environ/,                             // process env leakage
    /\b(LD_PRELOAD|LD_LIBRARY_PATH)\s*=/,                // dynamic linker hijack
    /\/dev\/tcp\//,                                       // bash built-in networking
    /\S+\(\)\s*\{[^}]*\|\s*\S+\s*&/,                    // fork bomb :(){ :|:& };:
    /while\s+true.*&\s*done/,                             // while true; do bash & done
];

// ════════════════════════════════════════════════════════════════════════════════
// 中危模式（warn）
// ════════════════════════════════════════════════════════════════════════════════

const _MEDIUM_RISK_PATTERNS = [
    /chmod\s+777/,
    /pip3?\s+install/,
    /apt(-get)?\s+install/,
    /\b(sudo|su)\b/,
    /\bPATH\s*=/,
];

// ════════════════════════════════════════════════════════════════════════════════
// 命令分割（处理 &&、||、; 等分隔符）
// ════════════════════════════════════════════════════════════════════════════════

function _splitCompoundCommand(command: string): string[] {
    const parts: string[] = [];
    let current: string[] = [];
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaping = false;
    let i = 0;

    while (i < command.length) {
        const ch = command[i];

        if (escaping) {
            current.push(ch);
            escaping = false;
            i++;
            continue;
        }

        if (ch === "\\" && !inSingleQuote) {
            current.push(ch);
            escaping = true;
            i++;
            continue;
        }

        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            current.push(ch);
            i++;
            continue;
        }

        if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            current.push(ch);
            i++;
            continue;
        }

        if (!inSingleQuote && !inDoubleQuote) {
            if (command.startsWith("&&", i) || command.startsWith("||", i)) {
                const part = current.join("").trim();
                if (part) parts.push(part);
                current = [];
                i += 2;
                continue;
            }
            if (ch === ";") {
                const part = current.join("").trim();
                if (part) parts.push(part);
                current = [];
                i++;
                continue;
            }
        }

        current.push(ch);
        i++;
    }

    // 未闭合的引号 → fail-closed，返回整条命令
    if (inSingleQuote || inDoubleQuote || escaping) {
        return [command];
    }

    const part = current.join("").trim();
    if (part) parts.push(part);
    return parts.length > 0 ? parts : [command];
}

// ════════════════════════════════════════════════════════════════════════════════
// 命令分类
// ════════════════════════════════════════════════════════════════════════════════

function _classifySingleCommand(command: string): "block" | "warn" | "pass" {
    const normalized = command.replace(/\s+/g, " ").trim();

    for (const pattern of _HIGH_RISK_PATTERNS) {
        if (pattern.test(normalized)) return "block";
    }

    for (const pattern of _MEDIUM_RISK_PATTERNS) {
        if (pattern.test(normalized)) return "warn";
    }

    return "pass";
}

function _classifyCommand(command: string): "block" | "warn" | "pass" {
    const normalized = command.replace(/\s+/g, " ").trim();

    // Pass 1：整条命令高危扫描（捕获跨语句的结构性攻击如 fork bomb）
    for (const pattern of _HIGH_RISK_PATTERNS) {
        if (pattern.test(normalized)) return "block";
    }

    // Pass 2：按子命令分类
    const subCommands = _splitCompoundCommand(command);
    let worst: "block" | "warn" | "pass" = "pass";
    for (const sub of subCommands) {
        const verdict = _classifySingleCommand(sub);
        if (verdict === "block") return "block";
        if (verdict === "warn") worst = "warn";
    }
    return worst;
}

// ════════════════════════════════════════════════════════════════════════════════
// 输入校验
// ════════════════════════════════════════════════════════════════════════════════

const _MAX_COMMAND_LENGTH = 10_000;

function _validateInput(command: string): string | null {
    if (!command.trim()) return "empty command";
    if (command.length > _MAX_COMMAND_LENGTH) return "command too long";
    if (command.includes("\x00")) return "null byte detected";
    return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 审计单条 bash 命令。
 *
 * @param command bash 命令
 * @param threadId 线程 ID
 * @returns { command, verdict, rejectReason }
 *   verdict: 'block' | 'warn' | 'pass'
 *   rejectReason: 输入校验失败的原因（仅 block 时）
 */
export function auditBashCommand(
    command: string,
    _threadId?: string | null,
): {
    command: string;
    verdict: "block" | "warn" | "pass";
    rejectReason: string | null;
} {
    // 输入校验
    const rejectReason = _validateInput(command);
    if (rejectReason) {
        return { command, verdict: "block", rejectReason };
    }

    // 命令分类
    const verdict = _classifyCommand(command);

    return { command, verdict, rejectReason: null };
}

/**
 * 构建阻断消息。
 */
export function buildBlockMessage(reason: string): string {
    return `Command blocked: ${reason}. Please use a safer alternative approach.`;
}

/**
 * 构建警告后缀。
 */
export function buildWarnSuffix(command: string): string {
    return `\n\n⚠️ Warning: \`${command}\` is a medium-risk command that may modify the runtime environment.`;
}
