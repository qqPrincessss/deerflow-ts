/**
 * 沙箱工具 — 供 LLM 调用的沙箱操作工具。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/tools.py
 *
 * 这是 DeerFlow 最核心的工具模块：
 * 所有文件的读写、命令执行、搜索都通过这些工具函数完成。
 * 每条工具调用都经过路径校验、安全门控、输出脱敏。
 */

// ════════════════════════════════════════════════════════════════════════════════
// 导入
// ════════════════════════════════════════════════════════════════════════════════

import { DEFAULT_SKILLS_CONTAINER_PATH } from "../constants.js";
import { VIRTUAL_PATH_PREFIX } from "../config/paths.js";
import { getAppConfig } from "../config/app_config.js";
import { type Runtime } from "../tools/types.js";
import { type ThreadDataState } from "../agents/thread_state.js";
import { resolveRuntimeUserId, getEffectiveUserId } from "../runtime/user_context.js";
import { readActiveSecrets } from "../runtime/secret_context.js";
import { type Sandbox, type GrepMatch } from "./sandbox.js";
import { getSandboxProvider } from "./sandbox_provider.js";
import { SandboxError, SandboxNotFoundError, SandboxRuntimeError } from "./exceptions.js";
import { withFileOperationLock } from "./file_operation_lock.js";
import { isHostBashAllowed, LOCAL_HOST_BASH_DISABLED_MESSAGE } from "./security.js";
import { buildOutputMaskPattern } from "./path_patterns.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量 & 正则
// ════════════════════════════════════════════════════════════════════════════════

const _ACP_WORKSPACE_VIRTUAL_PATH = "/mnt/acp-workspace";

const _DEFAULT_GLOB_MAX_RESULTS = 200;
const _MAX_GLOB_MAX_RESULTS = 1000;
const _DEFAULT_GREP_MAX_RESULTS = 100;
const _MAX_GREP_MAX_RESULTS = 500;
const _DEFAULT_WRITE_FILE_ERROR_MAX_CHARS = 2000;

/** 单次 write_file 内容上限（80 KB） */
const _WRITE_FILE_CONTENT_MAX_BYTES = 80 * 1024;
const _WRITE_FILE_MAX_BYTES_ENV = "DEERFLOW_WRITE_FILE_MAX_BYTES";

const _LOCAL_BASH_CWD_COMMANDS = new Set(["cd", "pushd"]);
const _LOCAL_BASH_COMMAND_WRAPPERS = new Set(["command", "builtin"]);
const _LOCAL_BASH_COMMAND_PREFIX_KEYWORDS = new Set([
    "!", "{", "case", "do", "elif", "else", "for", "if", "select", "then", "time", "until", "while",
]);
const _LOCAL_BASH_COMMAND_END_KEYWORDS = new Set(["}", "done", "esac", "fi"]);
const _LOCAL_BASH_ROOT_PATH_COMMANDS = new Set([
    "awk", "cat", "cp", "du", "find", "grep", "head", "less", "ln", "ls", "more", "mv", "rm", "sed", "tail", "tar",
]);
const _SHELL_COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "(", ")"]);
const _SHELL_REDIRECTION_OPERATORS = new Set(["<", ">", "<<", ">>", "<<<", "<>", ">&", "<&", "&>", "&>>", ">|"]);
const _LOCAL_BASH_SYSTEM_PATH_PREFIXES = [
    "/bin/", "/usr/bin/", "/usr/sbin/", "/sbin/", "/opt/homebrew/bin/", "/dev/",
];

const _ABSOLUTE_PATH_RE = /(?<![:\w])(?<!:\/)\/(?:[^\s"'`;&|<>()]+)/g;
const _IDENTIFIER_BRACE_BLOCK_RE = /\{([^{}]*)\}/g;
const _IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const _FILE_URL_RE = /\bfile:\/\/\S+/gi;
const _URL_WITH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const _DOTDOT_PATH_SEGMENT_RE = /(?:^|[/\\=])\.\.(?:$|[/\\])/;

/** 秘密脱敏标记 */
const _SECRET_REDACTION = "[redacted]";
const _MIN_MASK_LENGTH = 8;

/** 渠道用户 ID 环境变量 */
const _CHANNEL_USER_ID_ENV = "DEERFLOW_CHANNEL_USER_ID";
const _CHANNEL_USER_ID_CONTEXT_KEY = "channel_user_id";
const _CHANNEL_USER_ID_MAX_LEN = 256;

// ════════════════════════════════════════════════════════════════════════════════
// 缓存辅助
// ════════════════════════════════════════════════════════════════════════════════

const _cache = new Map<string, unknown>();

/** 组件 AppConfig 的 paths 属性（类型不确定，使用 any 读取） */
function _getBaseDir(): string {
    try {
        const config = getAppConfig() as Record<string, unknown>;
        const paths = config.paths as Record<string, unknown> | undefined;
        return (paths?.baseDir as string) ?? ".deer-flow";
    } catch {
        return ".deer-flow";
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 技能路径辅助
// ════════════════════════════════════════════════════════════════════════════════

const _SKILLS_CONTAINER_KEY = "_skills_container_path";

function _getSkillsContainerPath(): string {
    if (_cache.has(_SKILLS_CONTAINER_KEY)) return _cache.get(_SKILLS_CONTAINER_KEY) as string;
    try {
        const config = getAppConfig();
        const value: string = (config.skills as Record<string, unknown> | undefined)?.container_path as string
            ?? DEFAULT_SKILLS_CONTAINER_PATH;
        _cache.set(_SKILLS_CONTAINER_KEY, value);
        return value;
    } catch {
        return DEFAULT_SKILLS_CONTAINER_PATH;
    }
}

const _SKILLS_HOST_KEY = "_skills_host_path";

function _getSkillsHostPath(): string | null {
    if (_cache.has(_SKILLS_HOST_KEY)) return _cache.get(_SKILLS_HOST_KEY) as string | null;
    try {
        const config = getAppConfig();
        const skillsCfg = config.skills as Record<string, unknown> | undefined;
        const getSkillsPath = skillsCfg?.get_skills_path as (() => string) | undefined;
        if (getSkillsPath) {
            const skillsPath = getSkillsPath();
            const { existsSync } = require("node:fs");
            if (existsSync(skillsPath)) {
                _cache.set(_SKILLS_HOST_KEY, skillsPath);
                return skillsPath;
            }
        }
    } catch {
        // 失败不缓存
    }
    return null;
}

function _isSkillsPath(path: string): boolean {
    const prefix = _getSkillsContainerPath();
    return path === prefix || path.startsWith(`${prefix}/`);
}

function _extractSkillNameFromSkillsPath(path: string): string | null {
    const prefix = _getSkillsContainerPath();
    if (!_isSkillsPath(path)) return null;
    const relative = path.slice(prefix.length).replace(/^\/+/, "");
    if (!relative) return null;

    const parts = relative.split("/").filter(Boolean);
    if (parts.length >= 2 && ["public", "custom", "legacy"].includes(parts[0])) {
        return parts[1];
    }
    if (parts.length === 1 && ["public", "custom", "legacy"].includes(parts[0])) {
        return null;
    }
    if (parts.length >= 1) return parts[0];
    return null;
}

/**
 * 判断路径是否属于已禁用的技能。
 *
 * PUBLIC 技能的启用状态从全局 extensions_config.json 读取。
 * CUSTOM / LEGACY 技能的启用状态从 per-user _skill_states.json 读取。
 *
 * 当无法确定状态时，拒绝访问（fail closed）。
 */
function _isDisabledSkillPath(path: string, userId?: string | null): boolean {
    const skillName = _extractSkillNameFromSkillsPath(path);
    if (skillName === null) return false;

    try {
        const containerPath = _getSkillsContainerPath();
        const relative = path.slice(containerPath.length).replace(/^\/+/, "");

        let category: string;
        if (relative.startsWith("public/")) {
            category = "public";
        } else if (relative.startsWith("custom/")) {
            category = "custom";
        } else if (relative.startsWith("legacy/")) {
            category = "legacy";
        } else {
            // 无法确定分类时 fail closed
            return true;
        }

        if (category === "public") {
            return !_isPublicSkillEnabled(skillName);
        } else {
            const effectiveUserId = userId ?? getEffectiveUserId();
            return !_isCustomSkillEnabled(skillName, effectiveUserId);
        }
    } catch {
        // 读取配置失败时 fail closed
        return true;
    }
}

/**
 * 读取全局扩展配置，判断公开技能是否启用。
 */
function _isPublicSkillEnabled(skillName: string): boolean {
    const baseDir = _getBaseDir();
    const extConfigPath = `${baseDir}/extensions_config.json`;
    const { existsSync, readFileSync } = require("node:fs");
    if (!existsSync(extConfigPath)) return true; // 无配置时默认启用

    try {
        const raw = readFileSync(extConfigPath, "utf-8");
        const config = JSON.parse(raw);
        const skills = config.skills as Record<string, unknown> | undefined;
        if (!skills) return true;
        // extensions_config.json 格式: { "skills": { "bootstrap": { "enabled": true }, ... } }
        const skillEntry = skills[skillName] as Record<string, unknown> | undefined;
        if (skillEntry === undefined) return true; // 未显式配置的技能默认启用
        return skillEntry.enabled !== false;
    } catch {
        return true;
    }
}

/**
 * 读取 per-user 技能状态，判断自定义技能是否启用。
 */
function _isCustomSkillEnabled(skillName: string, userId: string): boolean {
    const baseDir = _getBaseDir();
    const statePath = `${baseDir}/users/${userId}/_skill_states.json`;
    const { existsSync, readFileSync } = require("node:fs");
    if (!existsSync(statePath)) return true; // 无配置时默认启用

    try {
        const raw = readFileSync(statePath, "utf-8");
        const states = JSON.parse(raw);
        // _skill_states.json 格式: { "my-skill": true, ... }
        const enabled = states[skillName];
        if (enabled === undefined) return true;
        return enabled !== false;
    } catch {
        return true;
    }
}

/**
 * 过滤掉属于禁用技能的路径。
 *
 * _isDisabledSkillPath 对每个*请求的*路径做门控，但对于 ls/glob/grep 这种
 * 会向下递归的工具，请求路径之上如果刚好是禁用技能的根，仍然会暴露出文件。
 * 这个函数对结果集中的每条路径做二次过滤。
 *
 * 每个 skill 的判断结果被缓存，避免 100 条 grep 结果变成 100 次配置文件读取。
 */
function _dropDisabledSkillPaths(paths: string[], userId?: string | null): string[] {
    const containerPath = _getSkillsContainerPath();
    const verdicts = new Map<string, boolean>();
    const kept: string[] = [];

    for (const path of paths) {
        const skillName = _extractSkillNameFromSkillsPath(path);
        if (skillName === null) {
            kept.push(path);
            continue;
        }
        // 用 (category, skillName) 做缓存 key
        const segment = path.slice(containerPath.length).replace(/^\/+/, "").split("/")[0];
        const key = `${segment}:${skillName}`;
        if (!verdicts.has(key)) {
            verdicts.set(key, _isDisabledSkillPath(path, userId));
        }
        if (!verdicts.get(key)!) {
            kept.push(path);
        }
    }

    return kept;
}

function _resolveSkillsPath(path: string): string {
    const container = _getSkillsContainerPath();
    const host = _getSkillsHostPath();
    if (host === null) {
        throw new Error(`Skills directory not available for path: ${path}`);
    }
    if (path === container) return host;

    const relative = path.slice(container.length).replace(/^\/+/, "");

    // 用户自定义技能路径解析
    if (relative === "custom" || relative.startsWith("custom/")) {
        const userId = getEffectiveUserId();
        const userCustomDir = `${_getBaseDir()}/users/${userId}/skills/custom`;
        const customRelative = relative.slice("custom".length).replace(/^\/+/, "");
        if (customRelative) return `${userCustomDir}/${customRelative}`;
        return userCustomDir;
    }

    return _joinPathPreservingStyle(host, relative);
}

// ════════════════════════════════════════════════════════════════════════════════
// ACP Workspace 路径辅助
// ════════════════════════════════════════════════════════════════════════════════

function _isAcpWorkspacePath(path: string): boolean {
    return path === _ACP_WORKSPACE_VIRTUAL_PATH || path.startsWith(`${_ACP_WORKSPACE_VIRTUAL_PATH}/`);
}

const _ACP_HOST_KEY = "_acp_workspace_host_path";

function _getAcpWorkspaceHostPath(threadId?: string): string | null {
    if (threadId) {
        try {
            const hostPath = `${_getBaseDir()}/threads/${threadId}/acp-workspace`;
            const { existsSync } = require("node:fs");
            if (existsSync(hostPath)) return hostPath;
        } catch {
            // ignore
        }
        return null;
    }

    if (_cache.has(_ACP_HOST_KEY)) return _cache.get(_ACP_HOST_KEY) as string | null;
    try {
        const baseDir = _getBaseDir();
        const hostPath = `${baseDir}/acp-workspace`;
        const { existsSync } = require("node:fs");
        if (existsSync(hostPath)) {
            _cache.set(_ACP_HOST_KEY, hostPath);
            return hostPath;
        }
    } catch {
        // ignore
    }
    return null;
}

function _rejectPathTraversal(path: string): void {
    const normalised = path.replace(/\\/g, "/");
    for (const segment of normalised.split("/")) {
        if (segment === "..") {
            throw new Error("Access denied: path traversal detected");
        }
    }
}

function _resolveAcpWorkspacePath(path: string, threadId?: string): string {
    _rejectPathTraversal(path);

    const hostPath = _getAcpWorkspaceHostPath(threadId);
    if (hostPath === null) {
        throw new Error(`ACP workspace directory not available for path: ${path}`);
    }
    if (path === _ACP_WORKSPACE_VIRTUAL_PATH) return hostPath;

    const relative = path.slice(_ACP_WORKSPACE_VIRTUAL_PATH.length).replace(/^\/+/, "");
    const resolved = _joinPathPreservingStyle(hostPath, relative);

    // 路径遍历二次校验（POSIX 风格）
    const { posix } = require("node:path");
    if (posix.commonpath([posix.normalize(hostPath), posix.normalize(resolved)]) !== posix.normalize(hostPath)) {
        throw new Error("Access denied: path traversal detected");
    }
    return resolved;
}

// ════════════════════════════════════════════════════════════════════════════════
// 自定义挂载路径辅助
// ════════════════════════════════════════════════════════════════════════════════

interface MountConfig {
    container_path: string;
    host_path: string;
    read_only?: boolean;
}

const _MOUNTS_KEY = "_custom_mounts";

function _getCustomMounts(): MountConfig[] {
    if (_cache.has(_MOUNTS_KEY)) return _cache.get(_MOUNTS_KEY) as MountConfig[];
    try {
        const config = getAppConfig();
        const sandboxCfg = config.sandbox as Record<string, unknown> | undefined;
        const rawMounts = sandboxCfg?.mounts as MountConfig[] | undefined;
        const mounts: MountConfig[] = [];
        if (rawMounts) {
            const { existsSync } = require("node:fs");
            for (const m of rawMounts) {
                if (existsSync(m.host_path)) mounts.push(m);
            }
        }
        _cache.set(_MOUNTS_KEY, mounts);
        return mounts;
    } catch {
        return [];
    }
}

function _isCustomMountPath(path: string): boolean {
    return _getCustomMounts().some(
        (m) => path === m.container_path || path.startsWith(`${m.container_path}/`),
    );
}

function _getCustomMountForPath(path: string): MountConfig | null {
    let best: MountConfig | null = null;
    for (const mount of _getCustomMounts()) {
        if (path === mount.container_path || path.startsWith(`${mount.container_path}/`)) {
            if (best === null || mount.container_path.length > best.container_path.length) {
                best = mount;
            }
        }
    }
    return best;
}

// ════════════════════════════════════════════════════════════════════════════════
// 虚拟 ↔ 实际路径映射
// ════════════════════════════════════════════════════════════════════════════════

function _threadVirtualToActualMappings(threadData: ThreadDataState): Map<string, string> {
    const mappings = new Map<string, string>();

    const workspace = threadData.workspace_path;
    const uploads = threadData.uploads_path;
    const outputs = threadData.outputs_path;

    if (workspace) mappings.set(`${VIRTUAL_PATH_PREFIX}/workspace`, workspace);
    if (uploads) mappings.set(`${VIRTUAL_PATH_PREFIX}/uploads`, uploads);
    if (outputs) mappings.set(`${VIRTUAL_PATH_PREFIX}/outputs`, outputs);

    // 如果所有目录共享同一个父目录，也映射虚拟根
    const actualDirs = [workspace, uploads, outputs].filter(Boolean) as string[];
    if (actualDirs.length > 0) {
        const { dirname } = require("node:path");
        const commonParent = dirname(actualDirs[0]);
        if (actualDirs.every((p) => dirname(p) === commonParent)) {
            mappings.set(VIRTUAL_PATH_PREFIX, commonParent);
        }
    }

    return mappings;
}

function _threadActualToVirtualMappings(threadData: ThreadDataState): Map<string, string> {
    const rev = new Map<string, string>();
    for (const [v, a] of _threadVirtualToActualMappings(threadData)) {
        rev.set(a, v);
    }
    return rev;
}

/**
 * 替换虚拟路径为实际路径。
 *
 * /mnt/user-data/workspace/* → threadData.workspace_path/*
 * /mnt/user-data/uploads/*  → threadData.uploads_path/*
 * /mnt/user-data/outputs/*  → threadData.outputs_path/*
 */
export function replaceVirtualPath(path: string, threadData: ThreadDataState | null): string {
    if (threadData === null) return path;

    const mappings = _threadVirtualToActualMappings(threadData);
    if (mappings.size === 0) return path;

    // 最长前缀优先
    const sorted = [...mappings.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [virtualBase, actualBase] of sorted) {
        if (path === virtualBase) return actualBase;
        if (path.startsWith(`${virtualBase}/`)) {
            const rest = path.slice(virtualBase.length).replace(/^\/+/, "");
            const result = _joinPathPreservingStyle(actualBase, rest);
            if (path.endsWith("/") && !result.endsWith("/") && !result.endsWith("\\")) {
                return result + _pathSeparatorForStyle(actualBase);
            }
            return result;
        }
    }
    return path;
}

// ════════════════════════════════════════════════════════════════════════════════
// 输出脱敏 — 宿主路径 → 虚拟路径
// ════════════════════════════════════════════════════════════════════════════════

function _pathVariants(path: string): Set<string> {
    return new Set([path, path.replace(/\\/g, "/"), path.replace(/\//g, "\\")]);
}

function _pathSeparatorForStyle(path: string): string {
    return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function _joinPathPreservingStyle(base: string, relative: string): string {
    if (!relative) return base;
    const separator = _pathSeparatorForStyle(base);
    const normalizedRelative = relative
        .replace(separator === "/" ? /\\/g : /\//g, separator)
        .replace(/^[/\\]+/, "");
    const strippedBase = base.replace(/[/\\]+$/, "");
    return `${strippedBase}${separator}${normalizedRelative}`;
}

interface MaskSourceEntry {
    hostBase: string;
    virtualBase: string;
}

function _compiledMaskPatterns(
    sources: MaskSourceEntry[],
): Array<{ pattern: RegExp; base: string; virtual: string }> {
    const results: Array<{ pattern: RegExp; base: string; virtual: string }> = [];
    const seen = new Set<string>();

    for (const { hostBase, virtualBase } of sources) {
        const { resolve: pathResolve } = require("node:path");
        const roots = [hostBase, pathResolve(hostBase)];

        for (const raw of roots) {
            for (const variant of _pathVariants(raw)) {
                if (seen.has(variant)) continue;
                seen.add(variant);
                const pattern = buildOutputMaskPattern(variant, true);
                results.push({ pattern, base: variant, virtual: virtualBase });
            }
        }
    }

    return results;
}

/**
 * 将本地沙箱输出中的宿主绝对路径脱敏回虚拟路径。
 *
 * 处理用户数据路径（per-thread）、技能路径（global + per-user custom）、
 * 和 ACP workspace 路径（per-thread）。
 */
export function maskLocalPathsInOutput(output: string, threadData: ThreadDataState | null): string {
    const sources: MaskSourceEntry[] = [];

    const skillsHost = _getSkillsHostPath();
    if (skillsHost) sources.push({ hostBase: skillsHost, virtualBase: _getSkillsContainerPath() });

    // 用户自定义技能路径
    try {
        const userId = getEffectiveUserId();
        const userCustomDir = `${_getBaseDir()}/users/${userId}/skills/custom`;
        const { existsSync } = require("node:fs");
        if (existsSync(userCustomDir)) {
            sources.push({ hostBase: userCustomDir, virtualBase: `${_getSkillsContainerPath()}/custom` });
        }
    } catch {
        // ignore
    }

    const acpHost = _getAcpWorkspaceHostPath(_extractThreadIdFromThreadData(threadData));
    if (acpHost) sources.push({ hostBase: acpHost, virtualBase: _ACP_WORKSPACE_VIRTUAL_PATH });

    if (threadData) {
        const mappings = _threadActualToVirtualMappings(threadData);
        const sorted = [...mappings.entries()].sort((a, b) => b[0].length - a[0].length);
        for (const [actualBase, virtualBase] of sorted) {
            sources.push({ hostBase: actualBase, virtualBase });
        }
    }

    if (sources.length === 0) return output;

    let result = output;
    for (const { pattern, base, virtual } of _compiledMaskPatterns(sources)) {
        result = result.replace(pattern, (match: string) => {
            if (match === base) return virtual;
            const relative = match.slice(base.length).replace(/^[/\\]+/, "");
            return relative ? `${virtual}/${relative}` : virtual;
        });
    }

    return result;
}

// ════════════════════════════════════════════════════════════════════════════════
// ThreadData 辅助
// ════════════════════════════════════════════════════════════════════════════════

function _extractThreadIdFromThreadData(threadData: ThreadDataState | null): string | undefined {
    if (threadData === null) return undefined;
    const workspacePath = threadData.workspace_path;
    if (!workspacePath) return undefined;
    try {
        // {base_dir}/threads/{thread_id}/user-data/workspace → parent.parent.name
        const { dirname, basename } = require("node:path");
        return basename(dirname(dirname(workspacePath)));
    } catch {
        return undefined;
    }
}

/**
 * 从 runtime 提取 thread_data。
 */
export function getThreadData(runtime: Runtime | null): ThreadDataState | null {
    if (runtime === null) return null;
    if (runtime.state === null || runtime.state === undefined) return null;
    return (runtime.state as any).thread_data as ThreadDataState ?? null;
}

/**
 * 判断当前是否本地沙箱。
 *
 * 接受通用 id "local" 和 per-thread 格式 "local:{userId}:{threadId}"。
 */
export function isLocalSandbox(runtime: Runtime | null): boolean {
    if (runtime === null) return false;
    if (runtime.state === null || runtime.state === undefined) return false;
    const sandboxState = (runtime.state as any).sandbox as Record<string, unknown> | undefined;
    if (!sandboxState) return false;
    const sandboxId = sandboxState.sandbox_id;
    if (typeof sandboxId !== "string") return false;
    return sandboxId === "local" || sandboxId.startsWith("local:");
}

// ════════════════════════════════════════════════════════════════════════════════
// 路径校验
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 校验路径是否允许本地沙箱访问。
 *
 * 允许的虚拟路径族：
 *   - /mnt/user-data/* — 读写允许
 *   - /mnt/skills/* — 仅读允许
 *   - /mnt/acp-workspace/* — 仅读允许
 *   - 自定义挂载路径 — 按配置的 read_only 决定
 *
 * @throws SandboxRuntimeError thread_data 缺失时
 * @throws Error 路径不允许或含遍历时
 */
export function validateLocalToolPath(
    path: string,
    threadData: ThreadDataState | null,
    readOnly: boolean = false,
): void {
    if (threadData === null) {
        throw new SandboxRuntimeError("Thread data not available for local sandbox");
    }

    _rejectPathTraversal(path);

    if (_isSkillsPath(path)) {
        if (!readOnly) throw new Error(`Write access to skills path is not allowed: ${path}`);
        return;
    }

    if (_isAcpWorkspacePath(path)) {
        if (!readOnly) throw new Error(`Write access to ACP workspace is not allowed: ${path}`);
        return;
    }

    if (path.startsWith(`${VIRTUAL_PATH_PREFIX}/`)) return;

    if (_isCustomMountPath(path)) {
        const mount = _getCustomMountForPath(path);
        if (mount && mount.read_only && !readOnly) {
            throw new Error(`Write access to read-only mount is not allowed: ${path}`);
        }
        return;
    }

    throw new Error(
        `Only paths under ${VIRTUAL_PATH_PREFIX}/, ${_getSkillsContainerPath()}/, ` +
        `${_ACP_WORKSPACE_VIRTUAL_PATH}/, or configured mount paths are allowed`,
    );
}

function _validateResolvedUserDataPath(resolved: string, threadData: ThreadDataState): void {
    const allowedRoots = [threadData.workspace_path, threadData.uploads_path, threadData.outputs_path]
        .filter(Boolean) as string[];

    if (allowedRoots.length === 0) {
        throw new SandboxRuntimeError("No allowed local sandbox directories configured");
    }

    const { resolve: pathResolve, relative } = require("node:path");
    const resolvedAbs = pathResolve(resolved);

    for (const root of allowedRoots) {
        const rootAbs = pathResolve(root);
        const rel = relative(rootAbs, resolvedAbs);
        if (!rel.startsWith("..") && !require("node:path").isAbsolute(rel)) return;
    }

    throw new Error("Access denied: path traversal detected");
}

function _resolveAndValidateUserDataPath(path: string, threadData: ThreadDataState): string {
    const resolvedStr = replaceVirtualPath(path, threadData);
    const { resolve: pathResolve } = require("node:path");
    const resolved = pathResolve(resolvedStr);
    _validateResolvedUserDataPath(resolved, threadData);
    return resolved;
}

/**
 * 公开的路径解析包装器。
 *
 * 解析 /mnt/user-data 虚拟路径并校验是否越界。
 */
export function resolveAndValidateUserDataPath(path: string, threadData: ThreadDataState): string {
    return _resolveAndValidateUserDataPath(path, threadData);
}

function _resolveLocalReadPath(path: string, threadData: ThreadDataState): string {
    validateLocalToolPath(path, threadData, true);
    if (_isSkillsPath(path) || _isAcpWorkspacePath(path) || _isCustomMountPath(path)) {
        return path; // 由 sandbox 的 PathMapping 解析
    }
    return _resolveAndValidateUserDataPath(path, threadData);
}

// ════════════════════════════════════════════════════════════════════════════════
// 格式化和截断工具
// ════════════════════════════════════════════════════════════════════════════════

function _formatGlobResults(rootPath: string, matches: string[], truncated: boolean): string {
    if (matches.length === 0) return `No files matched under ${rootPath}`;

    const lines = [`Found ${matches.length} paths under ${rootPath}`];
    if (truncated) lines[0] += ` (showing first ${matches.length})`;
    for (let i = 0; i < matches.length; i++) lines.push(`${i + 1}. ${matches[i]}`);
    if (truncated) lines.push("Results truncated. Narrow the path or pattern to see fewer matches.");
    return lines.join("\n");
}

function _formatGrepResults(rootPath: string, matches: GrepMatch[], truncated: boolean): string {
    if (matches.length === 0) return `No matches found under ${rootPath}`;

    const lines = [`Found ${matches.length} matches under ${rootPath}`];
    if (truncated) lines[0] += ` (showing first ${matches.length})`;
    for (const match of matches) lines.push(`${match.path}:${match.line_number}: ${match.line}`);
    if (truncated) lines.push("Results truncated. Narrow the path or add a glob filter.");
    return lines.join("\n");
}

function _truncateMiddle(output: string, maxChars: number, label: string): string {
    if (maxChars <= 0 || output.length <= maxChars) return output;
    const total = output.length;
    const markerTpl = `\n... [${label}: %d chars skipped] ...\n`;
    const markerLen = markerTpl.replace("%d", String(total)).length;
    const kept = Math.max(0, maxChars - markerLen);
    if (kept <= 0) return output.slice(0, maxChars);
    const headLen = Math.floor(kept / 2);
    const tailLen = kept - headLen;
    return `${output.slice(0, headLen)}\n... [${label}: ${total - kept} chars skipped] ...\n${output.slice(-tailLen)}`;
}

function _truncateHead(output: string, maxChars: number, marker: string): string {
    if (maxChars <= 0 || output.length <= maxChars) return output;
    const total = output.length;
    const markerLen = marker.replace("%d", String(total)).length;
    const kept = Math.max(0, maxChars - markerLen);
    if (kept <= 0) return output.slice(0, maxChars);
    return `${output.slice(0, kept)}${marker.replace("%d", String(total))}`;
}

function _truncateBashOutput(output: string, maxChars: number): string {
    return _truncateMiddle(output, maxChars, "middle truncated");
}

function _truncateReadFileOutput(output: string, maxChars: number): string {
    return _truncateHead(
        output,
        maxChars,
        "\n... [truncated: showing first %d of %d chars. Use start_line/end_line to read a specific range] ...",
    );
}

function _truncateLsOutput(output: string, maxChars: number): string {
    return _truncateHead(
        output,
        maxChars,
        "\n... [truncated: showing first %d of %d chars. Use a more specific path to see fewer results] ...",
    );
}

function _truncateWriteFileErrorDetail(detail: string, maxChars: number): string {
    return _truncateMiddle(detail, maxChars, "write_file error truncated");
}

// ════════════════════════════════════════════════════════════════════════════════
// 错误处理辅助
// ════════════════════════════════════════════════════════════════════════════════

function _sanitizeError(error: Error, runtime?: Runtime | null): string {
    const msg = `${error.constructor.name}: ${error.message}`;
    if (runtime && isLocalSandbox(runtime)) {
        return maskLocalPathsInOutput(msg, getThreadData(runtime));
    }
    return msg;
}

function _formatWriteFileError(
    requestedPath: string,
    error: Error,
    runtime?: Runtime | null,
    maxChars: number = _DEFAULT_WRITE_FILE_ERROR_MAX_CHARS,
): string {
    const header = `Error: Failed to write file '${requestedPath}'`;
    const detail = _sanitizeError(error, runtime);
    if (maxChars <= 0) return `${header}: ${detail}`;
    const budget = maxChars - header.length - 2;
    if (budget <= 0) return _truncateWriteFileErrorDetail(`${header}: ${detail}`, maxChars);
    return `${header}: ${_truncateWriteFileErrorDetail(detail, budget)}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// 配置读取辅助
// ════════════════════════════════════════════════════════════════════════════════

function _getMCPAllowedPaths(): string[] {
    try {
        const config = getAppConfig();
        const extensions = (config as Record<string, unknown>).extensions as Record<string, unknown> | undefined;
        if (!extensions) return [];

        const mcpServers = extensions.mcp_servers as Record<string, unknown> | undefined;
        if (!mcpServers) return [];

        const allowed: string[] = [];
        for (const [, server] of Object.entries(mcpServers)) {
            const srv = server as Record<string, unknown>;
            if (srv.enabled === false) continue;
            const args = (srv.args as string[]) ?? [];
            const hasFilesystem = args.some((a: string) => a.includes("server-filesystem"));
            if (!hasFilesystem) continue;
            for (const arg of args) {
                if (!arg.startsWith("-") && arg.startsWith("/")) {
                    allowed.push(arg.replace(/\/+$/, "") + "/");
                }
            }
        }
        return allowed;
    } catch {
        return [];
    }
}

function _getToolConfigInt(name: string, key: string, defaultVal: number): number {
    try {
        const config = getAppConfig();
        const getToolConfig = (config as Record<string, unknown>).get_tool_config as
            | ((n: string) => Record<string, unknown> | undefined)
            | undefined;
        if (getToolConfig) {
            const tc = getToolConfig(name);
            if (tc && key in tc && typeof tc[key] === "number") return tc[key] as number;
        }
    } catch {
        // ignore
    }
    return defaultVal;
}

function _clampMaxResults(value: number, defaultVal: number, upperBound: number): number {
    if (value <= 0) return defaultVal;
    return Math.min(value, upperBound);
}

function _resolveMaxResults(name: string, requested: number, defaultVal: number, upperBound: number): number {
    return Math.min(
        _clampMaxResults(requested, defaultVal, upperBound),
        _clampMaxResults(_getToolConfigInt(name, "max_results", defaultVal), defaultVal, upperBound),
    );
}

function _effectiveWriteFileMaxBytes(): number {
    const raw = process.env[_WRITE_FILE_MAX_BYTES_ENV];
    if (raw === undefined) return _WRITE_FILE_CONTENT_MAX_BYTES;
    try {
        return parseInt(raw, 10);
    } catch {
        return _WRITE_FILE_CONTENT_MAX_BYTES;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// Bash 安全校验
// ════════════════════════════════════════════════════════════════════════════════

function _isNonFileUrlToken(token: string): boolean {
    const values = [token];
    if (token.includes("=")) values.push(token.split("=", 2)[1]);
    for (const value of values) {
        const m = _URL_WITH_SCHEME_RE.exec(value);
        if (m && !value.toLowerCase().startsWith("file://")) return true;
    }
    return false;
}

function _nonFileUrlSpans(command: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const re = new RegExp(_URL_WITH_SCHEME_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
        if (!command.slice(m.index, m.index + m[0].length).toLowerCase().startsWith("file://")) {
            spans.push([m.index, m.index + m[0].length]);
        }
    }
    return spans;
}

function _isInSpans(position: number, spans: Array<[number, number]>): boolean {
    return spans.some(([s, e]) => s <= position && position < e);
}

function _hasDotdotPathSegment(token: string): boolean {
    if (_isNonFileUrlToken(token)) return false;
    _DOTDOT_PATH_SEGMENT_RE.lastIndex = 0;
    return _DOTDOT_PATH_SEGMENT_RE.test(token);
}

function _splitShellTokens(command: string): string[] {
    try {
        const normalized = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const tokens: string[] = [];
        let current = "";
        let inSingle = false;
        let inDouble = false;
        let escape = false;

        for (let i = 0; i < normalized.length; i++) {
            const ch = normalized[i];
            const next = i + 1 < normalized.length ? normalized[i + 1] : "";

            if (escape) { current += ch; escape = false; continue; }
            if (ch === "\\" && inDouble) { current += ch; escape = true; continue; }
            if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
            if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
            if (inSingle || inDouble) { current += ch; continue; }

            // 检测双字符操作符
            const twoChar = ch + next;
            if (twoChar === "&&" || twoChar === "||" || twoChar === "|&" ||
                twoChar === "<<" || twoChar === ">>" || twoChar === "<>" ||
                twoChar === ">&" || twoChar === "<&" || twoChar === "&>" ||
                twoChar === "&>>" || twoChar === ">|") {
                if (current) tokens.push(current);
                tokens.push(twoChar);
                current = "";
                i++; // 跳过下一个字符
                continue;
            }

            if (_SHELL_COMMAND_SEPARATORS.has(ch) || _SHELL_REDIRECTION_OPERATORS.has(ch)) {
                if (current) tokens.push(current);
                tokens.push(ch);
                current = "";
                continue;
            }

            if (/\s/.test(ch)) {
                if (current) { tokens.push(current); current = ""; }
                continue;
            }

            current += ch;
        }
        if (current) tokens.push(current);
        return tokens;
    } catch {
        return command.split(/\s+/).filter(Boolean);
    }
}

function _isShellCommandSeparator(token: string): boolean {
    return _SHELL_COMMAND_SEPARATORS.has(token);
}

function _isShellRedirectionOperator(token: string): boolean {
    return _SHELL_REDIRECTION_OPERATORS.has(token);
}

function _isShellAssignment(token: string): boolean {
    const eqIdx = token.indexOf("=");
    if (eqIdx <= 0) return false;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eqIdx));
}

function _isAllowedLocalBashAbsolutePath(
    path: string,
    allowedPaths: string[],
    allowSystemPaths: boolean,
): boolean {
    for (const allowed of allowedPaths) {
        const stripped = allowed.replace(/\/+$/, "");
        if (path === stripped || path.startsWith(allowed)) {
            _rejectPathTraversal(path);
            return true;
        }
    }

    if (path === VIRTUAL_PATH_PREFIX || path.startsWith(`${VIRTUAL_PATH_PREFIX}/`)) {
        _rejectPathTraversal(path);
        return true;
    }

    if (_isSkillsPath(path)) { _rejectPathTraversal(path); return true; }
    if (_isAcpWorkspacePath(path)) { _rejectPathTraversal(path); return true; }
    if (_isCustomMountPath(path)) { _rejectPathTraversal(path); return true; }

    if (allowSystemPaths) {
        for (const prefix of _LOCAL_BASH_SYSTEM_PATH_PREFIXES) {
            if (path === prefix.replace(/\/+$/, "") || path.startsWith(prefix)) return true;
        }
    }

    return false;
}

function _nextCdTarget(tokens: string[], startIndex: number): [string | null, number] {
    let idx = startIndex;
    while (idx < tokens.length) {
        const token = tokens[idx];
        if (_isShellCommandSeparator(token)) return [null, idx];
        if (_isShellRedirectionOperator(token)) { idx += 2; continue; }
        if (token === "--") { idx += 1; continue; }
        if (["-L", "-P", "-e", "-@"].includes(token)) { idx += 1; continue; }
        if (token.startsWith("-") && token !== "-") { idx += 1; continue; }
        return [token, idx + 1];
    }
    return [null, idx];
}

function _validateLocalBashCwdTarget(commandName: string, target: string | null, allowedPaths: string[]): void {
    if (target === null || target === "-") {
        throw new Error(
            `Unsafe working directory change in command: ${commandName}. Use paths under ${VIRTUAL_PATH_PREFIX}`,
        );
    }
    if (target.startsWith("$") || target.startsWith("`")) {
        throw new Error(
            `Unsafe working directory change in command: ${commandName} ${target}. Use paths under ${VIRTUAL_PATH_PREFIX}`,
        );
    }
    if (target.startsWith("~")) {
        throw new Error(
            `Unsafe working directory change in command: ${commandName} ${target}. Use paths under ${VIRTUAL_PATH_PREFIX}`,
        );
    }
    if (target.startsWith("/")) {
        _rejectPathTraversal(target);
        if (!_isAllowedLocalBashAbsolutePath(target, allowedPaths, false)) {
            throw new Error(
                `Unsafe working directory change in command: ${commandName} ${target}. Use paths under ${VIRTUAL_PATH_PREFIX}`,
            );
        }
    }
}

function _validateLocalBashRootPathArgs(commandName: string, tokens: string[], startIndex: number): void {
    if (!_LOCAL_BASH_ROOT_PATH_COMMANDS.has(commandName)) return;

    let idx = startIndex;
    while (idx < tokens.length) {
        const token = tokens[idx];
        if (_isShellCommandSeparator(token)) return;
        if (_isShellRedirectionOperator(token)) { idx += 2; continue; }
        if (token === "/" && !_isNonFileUrlToken(token)) {
            throw new Error(`Unsafe absolute paths in command: /. Use paths under ${VIRTUAL_PATH_PREFIX}`);
        }
        idx++;
    }
}

function _validateLocalBashShellTokens(command: string, allowedPaths: string[]): void {
    if (/\$\([^)]*\b(?:cd|pushd)\b/.test(command)) {
        throw new Error(
            `Unsafe working directory change in command substitution. Use paths under ${VIRTUAL_PATH_PREFIX}`,
        );
    }

    const tokens = _splitShellTokens(command);

    for (const token of tokens) {
        if (_isShellCommandSeparator(token) || _isShellRedirectionOperator(token)) continue;
        if (_hasDotdotPathSegment(token)) throw new Error("Access denied: path traversal detected");
    }

    let atCommandStart = true;
    let idx = 0;

    while (idx < tokens.length) {
        const token = tokens[idx];

        if (_isShellCommandSeparator(token)) { atCommandStart = true; idx++; continue; }
        if (_isShellRedirectionOperator(token)) { idx++; continue; }
        if (atCommandStart && _isShellAssignment(token)) { idx++; continue; }

        const cmdName = token.includes("/") ? token.split("/").pop()! : token;
        if (atCommandStart && (_LOCAL_BASH_COMMAND_PREFIX_KEYWORDS.has(cmdName) || _LOCAL_BASH_COMMAND_END_KEYWORDS.has(cmdName))) {
            idx++;
            continue;
        }
        if (!atCommandStart) { idx++; continue; }

        atCommandStart = false;

        if (_LOCAL_BASH_COMMAND_WRAPPERS.has(cmdName) && idx + 1 < tokens.length) {
            const wrapped = tokens[idx + 1].includes("/") ? tokens[idx + 1].split("/").pop()! : tokens[idx + 1];
            if (_LOCAL_BASH_CWD_COMMANDS.has(wrapped)) {
                const [target, next] = _nextCdTarget(tokens, idx + 2);
                _validateLocalBashCwdTarget(wrapped, target, allowedPaths);
                idx = next;
                continue;
            }
            _validateLocalBashRootPathArgs(wrapped, tokens, idx + 2);
        }

        if (!_LOCAL_BASH_CWD_COMMANDS.has(cmdName)) {
            _validateLocalBashRootPathArgs(cmdName, tokens, idx + 1);
            idx++;
            continue;
        }

        const [target, next] = _nextCdTarget(tokens, idx + 1);
        _validateLocalBashCwdTarget(cmdName, target, allowedPaths);
        idx = next;
    }
}

function _bracesAreIdentifierPlaceholdersOnly(fragment: string): boolean {
    if (fragment.includes("${")) return false;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(_IDENTIFIER_BRACE_BLOCK_RE.source, "g");
    while ((m = re.exec(fragment)) !== null) blocks.push(m[1]);
    const open = (fragment.match(/\{/g) || []).length;
    const close = (fragment.match(/\}/g) || []).length;
    if (open !== blocks.length || close !== blocks.length) return false;
    return blocks.every((inner) => _IDENTIFIER_RE.test(inner));
}

function _isNonPathLiteralFragment(fragment: string): boolean {
    if ([...fragment].some((ch) => ch.charCodeAt(0) > 127)) return true;
    if (fragment.includes("{") || fragment.includes("}")) return _bracesAreIdentifierPlaceholdersOnly(fragment);
    return false;
}

/**
 * 校验本地沙箱 bash 命令中的绝对路径。
 *
 * 这只是最佳努力的门控，不是安全沙箱边界。
 */
export function validateLocalBashCommandPaths(command: string, threadData: ThreadDataState | null): void {
    if (threadData === null) throw new SandboxRuntimeError("Thread data not available for local sandbox");

    _FILE_URL_RE.lastIndex = 0;
    const fileUrlMatch = _FILE_URL_RE.exec(command);
    if (fileUrlMatch) {
        throw new Error(
            `Unsafe file:// URL in command: ${fileUrlMatch[0]}. Use paths under ${VIRTUAL_PATH_PREFIX}`,
        );
    }

    const allowedPaths = _getMCPAllowedPaths();
    _validateLocalBashShellTokens(command, allowedPaths);
    const urlSpans = _nonFileUrlSpans(command);

    const unsafePaths: string[] = [];
    const absRe = new RegExp(_ABSOLUTE_PATH_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = absRe.exec(command)) !== null) {
        if (_isInSpans(m.index, urlSpans)) continue;
        if (_isNonPathLiteralFragment(m[0])) continue;
        if (_isAllowedLocalBashAbsolutePath(m[0], allowedPaths, true)) continue;
        unsafePaths.push(m[0]);
    }

    if (unsafePaths.length > 0) {
        const unsafe = [...new Set(unsafePaths)].sort().join(", ");
        throw new Error(`Unsafe absolute paths in command: ${unsafe}. Use paths under ${VIRTUAL_PATH_PREFIX}`);
    }
}

/**
 * 替换命令中的 /mnt/user-data 虚拟路径为实际路径。
 *
 * 技能路径和 ACP workspace 路径不由这里替换——
 * LocalSandbox._resolve_paths_in_command() 在执行时通过 PathMapping 解析。
 */
export function replaceVirtualPathsInCommand(command: string, threadData: ThreadDataState | null): string {
    if (!threadData || !command.includes(VIRTUAL_PATH_PREFIX)) return command;

    const escapedPrefix = VIRTUAL_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
        `${escapedPrefix}(?=/|$|[^\\w./-])(/[^\\s"';&|<>()]*)?`,
        "g",
    );

    return command.replace(pattern, (match: string) => {
        return replaceVirtualPath(match, threadData).replace(/\\/g, "/");
    });
}

function _applyCwdPrefix(command: string, threadData: ThreadDataState | null): string {
    if (threadData?.workspace_path) {
        return `cd ${threadData.workspace_path} && ${command}`;
    }
    return command;
}

// ════════════════════════════════════════════════════════════════════════════════
// 密钥和渠道身份注入
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从 bash 输出中脱敏注入的密钥。
 *
 * 技能脚本通过环境变量接收请求级密钥。如果脚本输出中包含密钥，
 * 将其替换为脱敏标记。最短值跳过（太短的值脱敏会破坏正常输出）。
 */
export function maskSecretValues(output: string, injectedEnv: Record<string, string> | null): string {
    if (!injectedEnv || !output) return output;

    const sorted = Object.values(injectedEnv)
        .filter((v) => v && v.length >= _MIN_MASK_LENGTH)
        .sort((a, b) => b.length - a.length);

    let result = output;
    for (const value of sorted) {
        // split + join = replaceAll
        result = result.split(value).join(_SECRET_REDACTION);
    }
    return result;
}

function _channelIdentityPrefix(runtime: Runtime): string | null {
    const ctx = runtime.context;
    if (!ctx || typeof ctx !== "object" || !(_CHANNEL_USER_ID_CONTEXT_KEY in ctx)) return null;

    const cid = ctx[_CHANNEL_USER_ID_CONTEXT_KEY];
    if (typeof cid === "string" && cid.length > 0 && cid.length <= _CHANNEL_USER_ID_MAX_LEN) {
        return `export ${_CHANNEL_USER_ID_ENV}=${cid}; `;
    }
    return `unset ${_CHANNEL_USER_ID_ENV}; `;
}

function _githubEnvFromRuntime(runtime: Runtime): Record<string, string> | null {
    const ctx = runtime.context;
    if (!ctx) return null;

    const value = ctx.github_token;
    let token: string | undefined;

    if (typeof value === "function") {
        try { token = value(); } catch { return null; }
    } else {
        token = value as string | undefined;
    }

    if (!token) return null;
    return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

function _isWindows(): boolean {
    return process.platform === "win32";
}

// ════════════════════════════════════════════════════════════════════════════════
// 沙箱生命周期
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从 runtime 提取沙箱实例。
 *
 * 已废弃：使用 ensureSandboxInitialized() 替代，它支持延迟初始化。
 *
 * @throws SandboxRuntimeError runtime 或 state 不存在时
 * @throws SandboxNotFoundError 沙箱 ID 找不到时
 */
export function sandboxFromRuntime(runtime?: Runtime | null): Promise<Sandbox> {
    return ensureSandboxInitialized(runtime);
}

/**
 * 确保沙箱已初始化，必要时延迟获取。
 *
 * 线程安全由 provider 内部锁保证。
 */
export async function ensureSandboxInitialized(runtime?: Runtime | null): Promise<Sandbox> {
    if (!runtime) throw new SandboxRuntimeError("Tool runtime not available");
    if (!runtime.state) throw new SandboxRuntimeError("Tool runtime state not available");

    // 检查是否已有沙箱
    const sandboxState = (runtime.state as any).sandbox as Record<string, unknown> | undefined;
    if (sandboxState) {
        const sandboxId = sandboxState.sandbox_id as string | undefined;
        if (sandboxId) {
            const provider = await getSandboxProvider();
            const sandbox = provider.get(sandboxId);
            if (sandbox) {
                if (runtime.context) runtime.context.sandbox_id = sandboxId;
                return sandbox;
            }
            // 沙箱已被释放，继续获取新的
        }
    }

    // 延迟获取
    const ctx = runtime.context;
    let threadId: string | undefined;
    if (ctx?.thread_id && typeof ctx.thread_id === "string") {
        threadId = ctx.thread_id;
    } else {
        const cfg = (runtime as unknown as Record<string, unknown>).config as Record<string, unknown> | undefined;
        const configurable = cfg?.configurable as Record<string, unknown> | undefined;
        if (configurable?.thread_id && typeof configurable.thread_id === "string") {
            threadId = configurable.thread_id;
        }
    }

    if (!threadId) throw new SandboxRuntimeError("Thread ID not available in runtime context");

    const provider = await getSandboxProvider();
    const newId = await provider.acquire(threadId, resolveRuntimeUserId(runtime));

    (runtime.state as any).sandbox = { sandbox_id: newId };

    const sandbox = provider.get(newId);
    if (!sandbox) throw new SandboxNotFoundError("Sandbox not found after acquisition", newId);

    if (runtime.context) runtime.context.sandbox_id = newId;
    return sandbox;
}

/**
 * 确保线程目录（workspace, uploads, outputs）存在。
 * 仅对本地沙箱创建目录。
 */
export function ensureThreadDirectoriesExist(runtime: Runtime | null): void {
    if (!runtime || !isLocalSandbox(runtime)) return;
    const state = runtime.state as any;
    if (state.thread_directories_created) return;

    const threadData = getThreadData(runtime);
    if (!threadData) return;

    const { mkdirSync } = require("node:fs");
    for (const key of ["workspace_path", "uploads_path", "outputs_path"] as const) {
        const p = threadData[key];
        if (p) mkdirSync(p, { recursive: true });
    }

    state.thread_directories_created = true;
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具函数：bash
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 在沙箱环境中执行 bash 命令。
 */
export async function bashTool(runtime: Runtime, _description: string, command: string): Promise<string> {
    try {
        const sandbox = await ensureSandboxInitialized(runtime);

        let injectedEnv = readActiveSecrets(runtime.context) || null;
        const identityPrefix = _channelIdentityPrefix(runtime);
        const githubEnv = _githubEnvFromRuntime(runtime);
        if (githubEnv) injectedEnv = { ...(injectedEnv ?? {}), ...githubEnv };

        let maxChars = 20000;
        let commandTimeout: number | undefined;
        try {
            const sc = getAppConfig().sandbox as Record<string, unknown> | undefined;
            if (sc) {
                maxChars = (sc.bash_output_max_chars as number) ?? 20000;
                commandTimeout = sc.bash_command_timeout as number | undefined;
            }
        } catch { /* use defaults */ }

        if (isLocalSandbox(runtime)) {
            if (!isHostBashAllowed()) return `Error: ${LOCAL_HOST_BASH_DISABLED_MESSAGE}`;
            ensureThreadDirectoriesExist(runtime);

            const threadData = getThreadData(runtime);
            validateLocalBashCommandPaths(command, threadData);
            command = replaceVirtualPathsInCommand(command, threadData);
            command = _applyCwdPrefix(command, threadData);

            if (identityPrefix && !_isWindows()) command = identityPrefix + command;

            const output = await sandbox.executeCommand(command, injectedEnv, commandTimeout);
            return _truncateBashOutput(
                maskSecretValues(maskLocalPathsInOutput(output, threadData), injectedEnv),
                maxChars,
            );
        }

        // 非本地沙箱（AIO / Docker）
        ensureThreadDirectoriesExist(runtime);
        command = `cd ${VIRTUAL_PATH_PREFIX}/workspace; ${command}`;
        if (identityPrefix) command = identityPrefix + command;

        const output = await sandbox.executeCommand(command, injectedEnv, commandTimeout);
        return _truncateBashOutput(maskSecretValues(output, injectedEnv), maxChars);
    } catch (error) {
        if (error instanceof SandboxError) return `Error: ${error.message}`;
        const msg = (error as Error).message;
        if (msg.includes("Permission denied")) return `Error: ${msg}`;
        return `Error: Unexpected error executing command: ${_sanitizeError(error as Error, runtime)}`;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具函数：ls
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 列出目录内容（最多 2 层树形结构）。
 */
export async function lsTool(runtime: Runtime, _description: string, path: string): Promise<string> {
    const requestedPath = path;
    try {
        // 禁用技能的目录不能被列出
        const userId = resolveRuntimeUserId(runtime);
        if (_isDisabledSkillPath(path, userId)) {
            const skillName = _extractSkillNameFromSkillsPath(path) ?? "unknown";
            return `Error: Skill '${skillName}' is disabled. Access to its files is blocked. Enable the skill in settings before using it.`;
        }
        const sandbox = await ensureSandboxInitialized(runtime);
        ensureThreadDirectoriesExist(runtime);

        let threadData: ThreadDataState | null = null;
        if (isLocalSandbox(runtime)) {
            threadData = getThreadData(runtime);
            validateLocalToolPath(path, threadData, true);
            if (!_isSkillsPath(path) && !_isAcpWorkspacePath(path) && !_isCustomMountPath(path)) {
                path = _resolveAndValidateUserDataPath(path, threadData!);
            }
        }

        const children = await sandbox.listDir(path);
        if (!children || children.length === 0) return "(empty)";

        let output = children.join("\n");
        if (threadData) output = maskLocalPathsInOutput(output, threadData);

        // 过滤禁用技能的路径
        const entries = _dropDisabledSkillPaths(output.split("\n"), userId);
        if (entries.length === 0) return "(empty)";
        output = entries.join("\n");

        let maxChars = 20000;
        try {
            const sc = getAppConfig().sandbox as Record<string, unknown> | undefined;
            if (sc) maxChars = (sc.ls_output_max_chars as number) ?? 20000;
        } catch { /* use defaults */ }

        return _truncateLsOutput(output, maxChars);
    } catch (error) {
        if (error instanceof SandboxError) return `Error: ${error.message}`;
        const msg = (error as Error).message;
        if (msg.includes("ENOENT") || msg.includes("not found")) return `Error: Directory not found: ${requestedPath}`;
        if (msg.includes("EACCES") || msg.includes("Permission denied")) return `Error: Permission denied: ${requestedPath}`;
        return `Error: Unexpected error listing directory: ${_sanitizeError(error as Error, runtime)}`;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具函数：glob
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 查找匹配 glob 模式的文件路径。
 */
export async function globTool(
    runtime: Runtime,
    _description: string,
    pattern: string,
    path: string,
    includeDirs: boolean = false,
    maxResults: number = _DEFAULT_GLOB_MAX_RESULTS,
): Promise<string> {
    const requestedPath = path;
    try {
        // 禁用技能的目录不能被搜索
        const userId = resolveRuntimeUserId(runtime);
        if (_isDisabledSkillPath(path, userId)) {
            const skillName = _extractSkillNameFromSkillsPath(path) ?? "unknown";
            return `Error: Skill '${skillName}' is disabled. Access to its files is blocked. Enable the skill in settings before using it.`;
        }
        const sandbox = await ensureSandboxInitialized(runtime);
        ensureThreadDirectoriesExist(runtime);

        const effective = _resolveMaxResults("glob", maxResults, _DEFAULT_GLOB_MAX_RESULTS, _MAX_GLOB_MAX_RESULTS);

        let threadData: ThreadDataState | null = null;
        if (isLocalSandbox(runtime)) {
            threadData = getThreadData(runtime);
            if (!threadData) throw new SandboxRuntimeError("Thread data not available for local sandbox");
            path = _resolveLocalReadPath(path, threadData);
        }

        const [matches, truncated] = await sandbox.glob(path, pattern, {
            include_dirs: includeDirs,
            max_results: effective,
        });

        const masked = threadData ? matches.map((m) => maskLocalPathsInOutput(m, threadData)) : matches;
        // 过滤禁用技能的路径
        const filtered = _dropDisabledSkillPaths(masked, userId);
        return _formatGlobResults(requestedPath, filtered, truncated);
    } catch (error) {
        if (error instanceof SandboxError) return `Error: ${error.message}`;
        const msg = (error as Error).message;
        if (msg.includes("ENOENT") || msg.includes("not found")) return `Error: Directory not found: ${requestedPath}`;
        if (msg.includes("EACCES") || msg.includes("Permission denied")) return `Error: Permission denied: ${requestedPath}`;
        return `Error: Unexpected error searching paths: ${_sanitizeError(error as Error, runtime)}`;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具函数：grep
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 搜索文件内容中的匹配行。
 */
export async function grepTool(
    runtime: Runtime,
    _description: string,
    pattern: string,
    path: string,
    globFilter?: string | null,
    literal: boolean = false,
    caseSensitive: boolean = false,
    maxResults: number = _DEFAULT_GREP_MAX_RESULTS,
): Promise<string> {
    const requestedPath = path;
    try {
        const sandbox = await ensureSandboxInitialized(runtime);
        ensureThreadDirectoriesExist(runtime);

        const effective = _resolveMaxResults("grep", maxResults, _DEFAULT_GREP_MAX_RESULTS, _MAX_GREP_MAX_RESULTS);

        let threadData: ThreadDataState | null = null;
        if (isLocalSandbox(runtime)) {
            threadData = getThreadData(runtime);
            if (!threadData) throw new SandboxRuntimeError("Thread data not available for local sandbox");
            path = _resolveLocalReadPath(path, threadData);
        }

        const [matches, truncated] = await sandbox.grep(path, pattern, {
            glob: globFilter ?? undefined,
            literal,
            case_sensitive: caseSensitive,
            max_results: effective,
        });

        if (threadData) {
            const masked: GrepMatch[] = matches.map((m) => ({
                ...m,
                path: maskLocalPathsInOutput(m.path, threadData),
            }));
            // 过滤禁用技能路径
            const userId = resolveRuntimeUserId(runtime);
            const allowed = new Set(_dropDisabledSkillPaths(masked.map((m) => m.path), userId));
            return _formatGrepResults(requestedPath, masked.filter((m) => allowed.has(m.path)), truncated);
        }

        // 过滤禁用技能路径
        const userId = resolveRuntimeUserId(runtime);
        const allowed = new Set(_dropDisabledSkillPaths(matches.map((m) => m.path), userId));
        return _formatGrepResults(requestedPath, matches.filter((m) => allowed.has(m.path)), truncated);
    } catch (error) {
        if (error instanceof SandboxError) return `Error: ${error.message}`;
        const msg = (error as Error).message;
        if (msg.includes("ENOENT") || msg.includes("not found")) return `Error: Directory not found: ${requestedPath}`;
        if (msg.includes("EACCES") || msg.includes("Permission denied")) return `Error: Permission denied: ${requestedPath}`;
        return `Error: Unexpected error searching file contents: ${_sanitizeError(error as Error, runtime)}`;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具函数：read_file
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 读取文件的当前内容，使用 read_file 的解析规则。
 *
 * 被 readFileTool 和 ReadBeforeWriteMiddleware 共享。
 *
 * @throws FileNotFoundError 文件不存在时
 */
export async function readCurrentFileContent(runtime: Runtime | null, path: string): Promise<string> {
    const sandbox = await ensureSandboxInitialized(runtime);
    ensureThreadDirectoriesExist(runtime);

    if (isLocalSandbox(runtime)) {
        const threadData = getThreadData(runtime);
        validateLocalToolPath(path, threadData, true);
        if (_isSkillsPath(path)) {
            path = _resolveSkillsPath(path);
        } else if (_isAcpWorkspacePath(path)) {
            path = _resolveAcpWorkspacePath(path, _extractThreadIdFromThreadData(threadData));
        } else if (!_isCustomMountPath(path)) {
            path = _resolveAndValidateUserDataPath(path, threadData!);
        }
    }

    return sandbox.readFile(path);
}

/**
 * 读取文件内容。
 *
 * 支持 startLine / endLine 参数读取指定行范围（1-indexed）。
 */
export async function readFileTool(
    runtime: Runtime,
    _description: string,
    path: string,
    startLine?: number | null,
    endLine?: number | null,
): Promise<string> {
    const requestedPath = path;
    try {
        // 禁用技能的文件不能被读取
        if (_isDisabledSkillPath(path, resolveRuntimeUserId(runtime))) {
            const skillName = _extractSkillNameFromSkillsPath(path) ?? "unknown";
            return `Error: Skill '${skillName}' is disabled. Access to its files is blocked. Enable the skill in settings before using it.`;
        }
        let content = await readCurrentFileContent(runtime, path);
        if (!content) return "(empty)";

        if (startLine != null || endLine != null) {
            const lines = content.split("\n");
            const s = Math.max(startLine ?? 1, 1);
            const e = endLine ?? lines.length;
            if (e < 1) return "(end_line must be >= 1)";
            if (s > lines.length) return "(start_line exceeds file length)";
            if (s > e) return "(start_line > end_line — no lines in range)";
            content = lines.slice(s - 1, e).join("\n");
        }

        let maxChars = 50000;
        try {
            const sc = getAppConfig().sandbox as Record<string, unknown> | undefined;
            if (sc) maxChars = (sc.read_file_output_max_chars as number) ?? 50000;
        } catch { /* use defaults */ }

        return _truncateReadFileOutput(content, maxChars);
    } catch (error) {
        if (error instanceof SandboxError) return `Error: ${error.message}`;
        const msg = (error as Error).message;
        if (msg.includes("ENOENT") || msg.includes("not found")) return `Error: File not found: ${requestedPath}`;
        if (msg.includes("EACCES") || msg.includes("Permission denied")) return `Error: Permission denied reading file: ${requestedPath}`;
        return (
            `Error: cannot read '${requestedPath}' as text — it appears to be a binary file ` +
            "(e.g. .xlsx, .pdf, or an image). read_file only supports UTF-8 text."
        );
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具函数：write_file
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 写入文件内容。
 *
 * 默认覆盖目标文件；append=True 时追加内容。
 * 非 append 模式有 80 KB 单次写入上限。
 */
export async function writeFileTool(
    runtime: Runtime,
    _description: string,
    path: string,
    content: string,
    append: boolean = false,
): Promise<string> {
    // 80KB 上限检查（append 不受限）
    if (!append) {
        const maxBytes = _effectiveWriteFileMaxBytes();
        if (maxBytes > 0) {
            const len = Buffer.byteLength(content, "utf-8");
            if (len > maxBytes) {
                return (
                    `Error: write_file content (${len} bytes) exceeds the ${maxBytes}-byte single-call limit. ` +
                    "Split the content: (a) write first section now, then use str_replace for edits, " +
                    "or (b) call write_file with append=True for the next section."
                );
            }
        }
    }

    const requestedPath = path;
    try {
        const sandbox = await ensureSandboxInitialized(runtime);
        ensureThreadDirectoriesExist(runtime);

        if (isLocalSandbox(runtime)) {
            const threadData = getThreadData(runtime);
            validateLocalToolPath(path, threadData);
            if (!_isCustomMountPath(path)) path = _resolveAndValidateUserDataPath(path, threadData!);
        }

        await withFileOperationLock(sandbox, path, async () => {
            await sandbox.writeFile(path, content, append);
        });

        return "OK";
    } catch (error) {
        if (error instanceof SandboxError) return _formatWriteFileError(requestedPath, error, runtime);
        const msg = (error as Error).message;
        if (msg.includes("EACCES") || msg.includes("Permission denied")) {
            return _truncateWriteFileErrorDetail(
                `Error: Permission denied writing to file: ${requestedPath}`,
                _DEFAULT_WRITE_FILE_ERROR_MAX_CHARS,
            );
        }
        return _formatWriteFileError(requestedPath, error as Error, runtime);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 工具函数：str_replace
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 替换文件中的子字符串。
 *
 * replaceAll=true 替换所有出现；否则（默认）只替换第一个。
 */
export async function strReplaceTool(
    runtime: Runtime,
    _description: string,
    path: string,
    oldStr: string,
    newStr: string,
    replaceAll: boolean = false,
): Promise<string> {
    const requestedPath = path;
    try {
        const sandbox = await ensureSandboxInitialized(runtime);
        ensureThreadDirectoriesExist(runtime);

        if (isLocalSandbox(runtime)) {
            const threadData = getThreadData(runtime);
            validateLocalToolPath(path, threadData);
            if (!_isCustomMountPath(path)) path = _resolveAndValidateUserDataPath(path, threadData!);
        }

        await withFileOperationLock(sandbox, path, async () => {
            const content = await sandbox.readFile(path);
            if (!content) {
                if (!oldStr) return;
                throw new SandboxError(`String to replace not found in file: ${requestedPath}`);
            }
            if (!content.includes(oldStr)) {
                throw new SandboxError(`String to replace not found in file: ${requestedPath}`);
            }
            const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
            await sandbox.writeFile(path, updated);
        });

        return "OK";
    } catch (error) {
        if (error instanceof SandboxError) return `Error: ${error.message}`;
        const msg = (error as Error).message;
        if (msg.includes("ENOENT") || msg.includes("not found")) return `Error: File not found: ${requestedPath}`;
        if (msg.includes("EACCES") || msg.includes("Permission denied")) return `Error: Permission denied accessing file: ${requestedPath}`;
        return `Error: Unexpected error replacing string: ${_sanitizeError(error as Error, runtime)}`;
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 导出清理函数（供测试使用）
// ════════════════════════════════════════════════════════════════════════════════

/** 重置内部缓存（供测试使用） */
export function _resetCache(): void {
    _cache.clear();
}
