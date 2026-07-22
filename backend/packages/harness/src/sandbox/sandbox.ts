/**
 * 沙箱抽象接口。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/sandbox.py
 */

// ════════════════════════════════════════════════════════════════
// 环境变量校验
// ════════════════════════════════════════════════════════════════

const _ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 校验环境变量名是否合法（POSIX 规范）。
 * 防止将来 shell 拼接实现时出现命令注入。
 */
export function validateExtraEnv(extraEnv: Record<string, string> | null | undefined): void {
    if (!extraEnv) return;
    for (const key of Object.keys(extraEnv)) {
        if (!_ENV_NAME_RE.test(key)) {
            throw new ValueError(
                `extra_env key "${key}" is not a valid POSIX environment variable name ` +
                `(must match ^[A-Za-z_][A-Za-z0-9_]*$).`
            );
        }
    }
}

// ════════════════════════════════════════════════════════════════
// 类型定义

// ════════════════════════════════════════════════════════════════

/** Grep 匹配结果 */
export interface GrepMatch {
    path: string;
    line_number: number;
    line: string;
    match_start: number;
    match_end: number;
}

/**
 * 沙箱抽象接口。
 *
 * 所有沙箱实现（本地、Docker、云端）都必须实现这个接口。
 */
export interface Sandbox {
    /** 沙箱唯一标识 */
    readonly id: string;

    /**
     * 执行 shell 命令。
     * @param command 命令
     * @param env 可选的环境变量（注入密钥用）
     * @param timeout 超时（秒）
     */
    executeCommand(
        command: string,
        env?: Record<string, string> | null,
        timeout?: number | null
    ): Promise<string>;

    /** 读取文件内容 */
    readFile(path: string): Promise<string>;

    /** 下载二进制文件 */
    downloadFile(path: string): Promise<ArrayBuffer>;

    /** 列出目录内容 */
    listDir(path: string, maxDepth?: number): Promise<string[]>;

    /** 写入文件 */
    writeFile(path: string, content: string, append?: boolean): Promise<void>;

    /** Glob 模式匹配 */
    glob(
        path: string,
        pattern: string,
        options?: { include_dirs?: boolean; max_results?: number }
    ): Promise<[string[], boolean]>;

    /** 在文件中搜索匹配 */
    grep(
        path: string,
        pattern: string,
        options?: {
            glob?: string;
            literal?: boolean;
            case_sensitive?: boolean;
            max_results?: number;
        }
    ): Promise<[GrepMatch[], boolean]>;

    /** 以二进制内容更新文件 */
    updateFile(path: string, content: ArrayBuffer): Promise<void>;
}

/**
 * TypeError 和 ValueError 的辅助类。
 */
export class ValueError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValueError";
    }
}
