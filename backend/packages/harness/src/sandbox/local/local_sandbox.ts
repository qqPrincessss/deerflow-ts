/**
 * 本地沙箱实现 — 本机直接执行命令。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/local/local_sandbox.py
 */

import { execSync, exec, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type Sandbox, type GrepMatch } from "../sandbox.js";
import { buildSandboxEnv } from "../env_policy.js";
import { buildOutputMaskPattern } from "../path_patterns.js";
import { findGlobMatches, findGrepMatches } from "../search.js";
import { listDir, type DirEntry } from "./list_dir.js";

// ════════════════════════════════════════════════════════════════
// 类型定义
// ════════════════════════════════════════════════════════════════

export interface PathMapping {
    containerPath: string;
    localPath: string;
    readOnly: boolean;
}

const VIRTUAL_PATH_PREFIX = "/mnt/user-data";

// ════════════════════════════════════════════════════════════════
// LocalSandbox 实现
// ════════════════════════════════════════════════════════════════

export class LocalSandbox implements Sandbox {
    readonly id: string;
    private pathMappings: PathMapping[];
    private commandTimeout: number;

    constructor(id: string, pathMappings: PathMapping[] = [], commandTimeout: number = 600) {
        this.id = id;
        this.pathMappings = pathMappings;
        this.commandTimeout = commandTimeout;
    }

    /** 虚拟路径转物理路径 */
    private resolvePath(virtualPath: string): string {
        for (const mapping of this.pathMappings) {
            if (virtualPath.startsWith(mapping.containerPath)) {
                const relative = virtualPath.slice(mapping.containerPath.length);
                return mapping.localPath + relative;
            }
        }
        return virtualPath;
    }

    /** 物理路径转虚拟路径 */
    private reverseResolvePath(physicalPath: string): string {
        for (const mapping of this.pathMappings) {
            if (physicalPath.startsWith(mapping.localPath)) {
                const relative = physicalPath.slice(mapping.localPath.length);
                return mapping.containerPath + relative;
            }
        }
        return physicalPath;
    }

    /** 掩码输出中的物理路径 */
    private maskPaths(output: string): string {
        let result = output;
        for (const mapping of this.pathMappings) {
            const pattern = buildOutputMaskPattern(mapping.localPath);
            result = result.replace(pattern, (match) => {
                return mapping.containerPath + match.slice(mapping.localPath.length);
            });
        }
        return result;
    }

    async executeCommand(
        command: string,
        env?: Record<string, string> | null,
        timeout?: number | null
    ): Promise<string> {
        const effectiveTimeout = timeout ?? this.commandTimeout;
        const sandboxEnv = buildSandboxEnv(env ?? undefined);

        return new Promise((resolve, reject) => {
            const child = exec(command, {
                timeout: effectiveTimeout * 1000,
                env: sandboxEnv,
            }, (error, stdout, stderr) => {
                let output = stdout || "";
                if (stderr) output += "\n[stderr]\n" + stderr;
                if (error) {
                    if ("signal" in error && error.signal === "SIGTERM") {
                        output += "\n[Command timed out]";
                    } else {
                        output += `\n[exit code: ${error.code ?? -1}]`;
                    }
                }
                resolve(this.maskPaths(output || "(no output)"));
            });
        });
    }

    async readFile(path: string): Promise<string> {
        const physicalPath = this.resolvePath(path);
        try {
            return readFileSync(physicalPath, "utf-8");
        } catch (err) {
            return `Error: ${(err as Error).message}`;
        }
    }

    async downloadFile(path: string): Promise<ArrayBuffer> {
        const physicalPath = this.resolvePath(path);
        return readFileSync(physicalPath).buffer;
    }

    async writeFile(path: string, content: string, append: boolean = false): Promise<void> {
        const physicalPath = this.resolvePath(path);
        mkdirSync(dirname(physicalPath), { recursive: true });
        if (append) {
            writeFileSync(physicalPath, content, { flag: "a", encoding: "utf-8" });
        } else {
            writeFileSync(physicalPath, content, "utf-8");
        }
    }

    async listDir(path: string, maxDepth: number = 2): Promise<string[]> {
        const physicalPath = this.resolvePath(path);
        const entries = listDir(physicalPath, maxDepth);
        return entries.map((e) => this.reverseResolvePath(e.path));
    }

    async glob(
        path: string,
        pattern: string,
        options?: { include_dirs?: boolean; max_results?: number }
    ): Promise<[string[], boolean]> {
        const physicalPath = this.resolvePath(path);
        const [matches, truncated] = findGlobMatches(physicalPath, pattern, options);
        return [matches.map((m) => this.reverseResolvePath(m)), truncated];
    }

    async grep(
        path: string,
        pattern: string,
        options?: {
            glob?: string;
            literal?: boolean;
            case_sensitive?: boolean;
            max_results?: number;
        }
    ): Promise<[GrepMatch[], boolean]> {
        const physicalPath = this.resolvePath(path);
        return findGrepMatches(physicalPath, pattern, options);
    }

    async updateFile(path: string, content: ArrayBuffer): Promise<void> {
        const physicalPath = this.resolvePath(path);
        mkdirSync(dirname(physicalPath), { recursive: true });
        writeFileSync(physicalPath, Buffer.from(content));
    }
}
