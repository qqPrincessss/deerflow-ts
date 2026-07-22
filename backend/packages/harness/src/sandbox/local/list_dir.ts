/**
 * 本地沙箱目录列表。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/local/list_dir.py
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

export interface DirEntry {
    name: string;
    path: string;
    type: "file" | "dir" | "symlink";
    size?: number;
}

export function listDir(root: string, maxDepth: number = 2): DirEntry[] {
    const entries: DirEntry[] = [];

    function walk(dir: string, depth: number): void {
        if (depth > maxDepth) return;
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }

        for (const name of names) {
            const fullPath = join(dir, name);
            let stat;
            try {
                stat = statSync(fullPath);
            } catch {
                continue;
            }

            const entry: DirEntry = {
                name,
                path: fullPath,
                type: stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file",
                size: stat.isFile() ? stat.size : undefined,
            };
            entries.push(entry);

            if (stat.isDirectory() && depth < maxDepth) {
                walk(fullPath, depth + 1);
            }
        }
    }

    walk(root, 0);
    return entries;
}
