/**
 * 技能文件系统权限工具 — 安装后设置沙箱可读权限。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/permissions.py
 */

import { chmodSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 将单个路径设置为沙箱可读（移除组/其他写权限，添加读权限）。
 */
export function makeSkillPathSandboxReadable(filePath: string): void {
    if (!existsSync(filePath)) return;

    const stat = statSync(filePath);
    // 检查是否是符号链接（Windows 上不做检查）
    try {
        if (stat.isSymbolicLink && stat.isSymbolicLink()) return;
    } catch { /* 忽略 */ }

    // 获取当前模式，去掉组写和其他写，添加读
    const currentMode = stat.mode;
    const withoutWrite = currentMode & ~0o022; // 去掉组写和其他写

    if (stat.isDirectory()) {
        chmodSync(filePath, withoutWrite | 0o555); // r-xr-xr-x
    } else if (stat.isFile()) {
        chmodSync(filePath, withoutWrite | 0o444); // r--r--r--
    }
}

/**
 * 将整个技能目录树设置为沙箱可读。
 */
export function makeSkillTreeSandboxReadable(target: string): void {
    if (!existsSync(target)) return;
    makeSkillPathSandboxReadable(target);

    const { readdirSync } = require("node:fs");
    const { join } = require("node:path");

    function walk(dir: string): void {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch { return; }
        for (const name of entries) {
            const fullPath = join(dir, name);
            makeSkillPathSandboxReadable(fullPath);
            try {
                if (statSync(fullPath).isDirectory()) walk(fullPath);
            } catch { /* 忽略 */ }
        }
    }

    walk(target);
}

/**
 * 设置写入的技能文件路径为沙箱可读（包括父目录链）。
 */
export function makeSkillWrittenPathSandboxReadable(skillRoot: string, target: string): void {
    const resolvedRoot = resolve(skillRoot);
    const resolvedTarget = resolve(target);

    // 验证 target 在 skillRoot 下
    if (!resolvedTarget.startsWith(resolvedRoot + "/") && resolvedTarget !== resolvedRoot) {
        throw new Error("Target path is not within the skill root");
    }

    // 设置根目录
    makeSkillPathSandboxReadable(resolvedRoot);

    // 设置父目录链
    if (resolvedTarget !== resolvedRoot) {
        const relativeParts = resolvedTarget.replace(resolvedRoot, "").replace(/^[/\\]+/, "").split(/[/\\]/);
        let current = resolvedRoot;
        for (const part of relativeParts) {
            current = `${current}/${part}`;
            makeSkillPathSandboxReadable(current);
        }
    }

    // 设置目标文件
    makeSkillPathSandboxReadable(resolvedTarget);
}
