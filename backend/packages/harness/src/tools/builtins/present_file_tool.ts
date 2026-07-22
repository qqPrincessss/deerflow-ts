/**
 * 展示文件工具 — 让用户可以查看和渲染生成的文件。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/builtins/present_file_tool.py
 *
 * 当 Agent 创建了 HTML 报告、Markdown、图片等文件后，
 * 调用这个工具把它们标记为"可供用户查看"。
 * 只允许展示 /mnt/user-data/outputs 目录下的文件。
 */

import { VIRTUAL_PATH_PREFIX } from "../../config/paths.js";
import { getAppConfig } from "../../config/app_config.js";
import { getEffectiveUserId } from "../../runtime/user_context.js";
import { type Runtime } from "../types.js";

export const OUTPUTS_VIRTUAL_PREFIX = `${VIRTUAL_PATH_PREFIX}/outputs`;

function _getThreadId(runtime: Runtime): string | null {
    // 优先从 runtime.context 获取
    const ctx = runtime.context;
    if (ctx?.thread_id && typeof ctx.thread_id === "string") {
        return ctx.thread_id;
    }

    // 其次从 runtime.config.configurable 获取
    const config = (runtime as Record<string, unknown>).config as Record<string, unknown> | undefined;
    const configurable = config?.configurable as Record<string, unknown> | undefined;
    if (configurable?.thread_id && typeof configurable.thread_id === "string") {
        return configurable.thread_id;
    }

    return null;
}

/**
 * 规范化文件路径到 /mnt/user-data/outputs/* 格式。
 *
 * 接受两种输入：
 * - 虚拟沙箱路径：/mnt/user-data/outputs/report.md
 * - 宿主线程输出路径：/app/.deer-flow/threads/<id>/user-data/outputs/report.md
 *
 * @returns 规范化的虚拟路径
 * @throws Error 如果元数据缺失或文件不在当前线程的 outputs 目录下
 */
function _normalizePresentedFilepath(
    runtime: Runtime,
    filepath: string,
): string {
    if (!runtime.state) {
        throw new Error("Thread runtime state is not available");
    }

    const threadId = _getThreadId(runtime);
    if (!threadId) {
        throw new Error("Thread ID is not available in runtime context or runtime config");
    }

    const state = runtime.state as any;
    const threadData = (state.thread_data ?? {}) as Record<string, unknown>;
    const outputsPath = threadData.outputs_path as string | undefined;
    if (!outputsPath) {
        throw new Error("Thread outputs path is not available in runtime state");
    }

    const outputsDir = outputsPath.replace(/[/\\]+$/, "");
    const stripped = filepath.replace(/^\/+/, "");
    const virtualPrefix = VIRTUAL_PATH_PREFIX.replace(/^\/+/, "");

    let actualPath: string;

    if (stripped === virtualPrefix || stripped.startsWith(`${virtualPrefix}/`)) {
        // 虚拟路径：通过 resolveVirtualPath 解析
        try {
            const baseDir = (getAppConfig() as Record<string, unknown>).paths as Record<string, unknown> | undefined;
            const resolveFn = (baseDir as Record<string, unknown> | undefined)?.resolve_virtual_path as
                ((tid: string, fp: string, uid?: string) => string) | undefined;
            if (resolveFn) {
                try {
                    actualPath = resolveFn(threadId, filepath, getEffectiveUserId());
                } catch {
                    actualPath = resolveFn(threadId, filepath);
                }
            } else {
                // 手动解析
                const userDataPrefix = `${VIRTUAL_PATH_PREFIX}/`;
                if (filepath.startsWith(userDataPrefix)) {
                    const relative = filepath.slice(userDataPrefix.length);
                    actualPath = `${outputsDir}/../${relative}`;
                } else {
                    actualPath = filepath;
                }
            }
        } catch {
            actualPath = filepath;
        }
    } else {
        // 宿主路径
        const { resolve: pathResolve } = require("node:path");
        actualPath = pathResolve(filepath.replace(/^~/, process.env.HOME || ""));
    }

    // 校验路径是否在 outputs 目录下
    const { relative, sep } = require("node:path");
    const relPath = relative(outputsDir, actualPath);
    if (relPath.startsWith("..") || require("node:path").isAbsolute(relPath)) {
        throw new Error(`Only files in ${OUTPUTS_VIRTUAL_PREFIX} can be presented: ${filepath}`);
    }

    // 返回规范化的虚拟路径（统一为 POSIX 风格）
    const posixRelPath = relPath.split(sep).join("/");
    return `${OUTPUTS_VIRTUAL_PREFIX}/${posixRelPath}`;
}

/**
 * 展示文件给用户查看和渲染。
 *
 * 调用时机：
 * - 创建完文件并移动到 /mnt/user-data/outputs 后
 * - 想让用户查看、下载或交互文件时
 * - 一次展示多个相关文件
 *
 * 不适用场景：
 * - 只需要自己读取文件内容做处理
 * - 临时或中间文件，不需要用户查看
 *
 * @param filepaths 要展示的绝对路径列表（必须在线程的 outputs 目录下）
 * @returns 操作结果字符串
 */
export function presentFileTool(
    runtime: Runtime,
    filepaths: string[],
): string {
    try {
        const normalizedPaths = filepaths.map((fp) =>
            _normalizePresentedFilepath(runtime, fp),
        );
        return `Successfully presented files:\n${normalizedPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
    } catch (error) {
        return `Error: ${(error as Error).message}`;
    }
}
