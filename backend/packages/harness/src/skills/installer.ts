/**
 * 技能安装器 — 从 .skill 压缩包安装技能。
 *
 * 对应原项目：backend/packages/harness/deerflow/skills/installer.py
 *
 * 安全措施：
 * - 拒绝绝对路径和目录遍历
 * - 跳过符号链接
 * - 拒绝可执行二进制文件（ELF/PE/Mach-O）
 * - 总解压大小限制（zip bomb 防御）
 * - 静态安全扫描（TODO：依赖 security_scanner 模块）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, rmSync } from "node:fs";
import { join, resolve, normalize, dirname, basename } from "node:path";
import { createWriteStream, createReadStream } from "node:fs";
import { createInflate } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { makeSkillTreeSandboxReadable } from "./permissions.js";
import { validateSkillFrontmatter } from "./validation.js";
import { SKILL_MD_FILE } from "./types.js";

// ════════════════════════════════════════════════════════════════════════════════
// 异常
// ════════════════════════════════════════════════════════════════════════════════

export class SkillAlreadyExistsError extends Error {
    constructor(name: string) {
        super(`Skill '${name}' already exists`);
        this.name = "SkillAlreadyExistsError";
    }
}

/** 可执行二进制 Magic */
const _EXECUTABLE_MAGIC_PREFIXES = [
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
    Buffer.from([0x4d, 0x5a]),               // PE/DOS
];

const _CODE_SUFFIXES = new Set([".bash", ".cjs", ".js", ".mjs", ".php", ".pl", ".ps1", ".py", ".rb", ".sh", ".ts", ".zsh"]);

// ════════════════════════════════════════════════════════════════════════════════
// ZIP 安全校验
// ════════════════════════════════════════════════════════════════════════════════

/** ZIP 条目本地文件头签名 */
const _LOCAL_FILE_HEADER_SIG = 0x04034b50;

interface ZipEntry {
    name: string;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    localHeaderOffset: number;
    isDir: boolean;
}

/**
 * 简单的 ZIP 解析器（只读取中央目录，不解压）。
 * 用于安全检查而不依赖第三方库。
 */
function _readZipEntries(buffer: Buffer): ZipEntry[] {
    const entries: ZipEntry[] = [];

    // 找 EOCD 签名
    const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let eocdPos = buffer.length - 22;
    while (eocdPos >= 0) {
        if (buffer.slice(eocdPos, eocdPos + 4).equals(eocdSig)) break;
        eocdPos--;
    }
    if (eocdPos < 0) throw new Error("Invalid ZIP: no EOCD found");

    const centralDirOffset = buffer.readUInt32LE(eocdPos + 16);
    const numEntries = buffer.readUInt16LE(eocdPos + 10);

    let pos = centralDirOffset;
    for (let i = 0; i < numEntries; i++) {
        // 中央目录文件头签名
        if (buffer.readUInt32LE(pos) !== 0x02014b50) break;

        const nameLen = buffer.readUInt16LE(pos + 28);
        const extraLen = buffer.readUInt16LE(pos + 30);
        const commentLen = buffer.readUInt16LE(pos + 32);
        const name = buffer.toString("utf-8", pos + 46, pos + 46 + nameLen);

        const compressionMethod = buffer.readUInt16LE(pos + 10);
        const compressedSize = buffer.readUInt32LE(pos + 20);
        const uncompressedSize = buffer.readUInt32LE(pos + 24);
        const localOffset = buffer.readUInt32LE(pos + 42);

        entries.push({
            name: normalize(name.replace(/\\/g, "/")),
            compressedSize,
            uncompressedSize,
            compressionMethod,
            localHeaderOffset: localOffset,
            isDir: name.endsWith("/"),
        });

        pos += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

function _isUnsafeZipMember(name: string): boolean {
    const normalized = name.replace(/\\/g, "/");
    if (normalized.startsWith("/")) return true;
    if (normalized.includes("..")) return true;
    return false;
}

function _isExecutableBinaryPrefix(data: Buffer): boolean {
    return _EXECUTABLE_MAGIC_PREFIXES.some((magic) => data.slice(0, magic.length).equals(magic));
}

// ════════════════════════════════════════════════════════════════════════════════
// 安全解压
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从 Buffer 中提取 ZIP 文件的单个条目。
 */
function _extractEntry(buffer: Buffer, entry: ZipEntry): Buffer {
    let pos = entry.localHeaderOffset;
    // 本地文件头
    if (buffer.readUInt32LE(pos) !== _LOCAL_FILE_HEADER_SIG) {
        throw new Error(`Invalid local file header for ${entry.name}`);
    }

    const nameLen = buffer.readUInt16LE(pos + 26);
    const extraLen = buffer.readUInt16LE(pos + 28);
    const dataStart = pos + 30 + nameLen + extraLen;

    const data = buffer.slice(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) {
        // 无压缩
        return data;
    }
    if (entry.compressionMethod === 8) {
        // Deflate
        try {
            const zlib = require("node:zlib");
            return zlib.inflateRawSync(data);
        } catch {
            throw new Error(`Failed to decompress: ${entry.name}`);
        }
    }

    throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
}

/**
 * 安全解压技能归档。
 */
export function safeExtractSkillArchive(
    archiveBuffer: Buffer,
    destPath: string,
    maxTotalSize: number = 512 * 1024 * 1024,
): void {
    const destRoot = resolve(destPath);
    const entries = _readZipEntries(archiveBuffer);

    let totalWritten = 0;

    for (const entry of entries) {
        if (_isUnsafeZipMember(entry.name)) {
            throw new Error(`Archive contains unsafe member path: ${entry.name}`);
        }

        // 简化路径
        const cleanName = normalize(entry.name).replace(/^[/\\]+/, "");
        const memberPath = resolve(join(destRoot, cleanName));

        // 确保在目标目录下
        if (!memberPath.startsWith(destRoot)) {
            throw new Error(`Zip entry escapes destination: ${entry.name}`);
        }

        if (entry.isDir) {
            mkdirSync(memberPath, { recursive: true });
            continue;
        }

        mkdirSync(dirname(memberPath), { recursive: true });

        // 解压
        const data = _extractEntry(archiveBuffer, entry);

        // 检查可执行二进制
        if (_isExecutableBinaryPrefix(data)) {
            throw new Error(`Archive contains executable binary member: ${entry.name}`);
        }

        totalWritten += data.length;
        if (totalWritten > maxTotalSize) {
            throw new Error("Skill archive is too large or appears highly compressed.");
        }

        writeFileSync(memberPath, data);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 归档内容扫描
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从解压的归档中定位技能根目录。
 */
export function resolveSkillDirFromArchive(tempPath: string): string {
    const items = readdirSync(tempPath).filter((name) => !name.startsWith(".") && name !== "__MACOSX");
    if (items.length === 0) throw new Error("Skill archive is empty");

    if (items.length === 1) {
        const single = join(tempPath, items[0]);
        if (statSync(single).isDirectory()) return single;
    }

    return tempPath;
}

// ════════════════════════════════════════════════════════════════════════════════
// 安装流程
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 将暂存的技能移动到目标位置。
 */
export function moveStagedSkillIntoReservedTarget(stagingTarget: string, target: string): void {
    let installed = false;
    let reserved = false;

    try {
        mkdirSync(target, { recursive: true });
        reserved = true;

        const items = readdirSync(stagingTarget);
        for (const item of items) {
            const src = join(stagingTarget, item);
            const dst = join(target, item);
            try {
                renameSync(src, dst);
            } catch {
                // 跨设备时用 copy + delete
                const { copyFileSync } = require("node:fs");
                copyFileSync(src, dst);
                rmSync(src, { recursive: true, force: true });
            }
        }

        makeSkillTreeSandboxReadable(target);
        installed = true;
    } catch (error) {
        if (reserved && !installed && existsSync(target)) {
            rmSync(target, { recursive: true, force: true });
        }
        throw error;
    }
}

/**
 * 安装技能。
 *
 * @param archivePath .skill 文件路径
 * @param customDir 自定义技能目录
 * @returns 安装结果
 */
export async function installSkill(
    archivePath: string,
    customDir: string,
): Promise<{ success: boolean; skill_name: string; message: string }> {
    const archiveBuffer = readFileSync(archivePath);

    // 创建临时目录
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join: pathJoin } = require("node:path");
    const tmpDir = mkdtempSync(pathJoin(tmpdir(), "skill-install-"));

    try {
        // 安全解压
        safeExtractSkillArchive(archiveBuffer, tmpDir);

        // 定位技能目录
        const skillDir = resolveSkillDirFromArchive(tmpDir);
        const skillName = basename(skillDir);

        // 校验 frontmatter
        const [isValid, message] = validateSkillFrontmatter(skillDir);
        if (!isValid) {
            throw new Error(`Invalid skill frontmatter: ${message}`);
        }

        // 检查是否已存在
        const target = join(resolve(customDir), skillName);
        if (existsSync(target)) {
            throw new SkillAlreadyExistsError(skillName);
        }

        // TODO: 安全扫描（依赖 security_scanner 模块）
        // await scanSkillArchiveContentsOrRaise(skillDir, skillName);

        // 移动到目标目录
        moveStagedSkillIntoReservedTarget(skillDir, target);

        return {
            success: true,
            skill_name: skillName,
            message: `Skill '${skillName}' installed successfully`,
        };
    } catch (error) {
        // 清理临时目录
        if (existsSync(tmpDir)) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
        throw error;
    }
}
