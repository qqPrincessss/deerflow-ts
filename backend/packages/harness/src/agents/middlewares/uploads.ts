/**
 * 上传文件中间件 — 将上传文件信息注入 Agent 上下文。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/uploads_middleware.py
 *
 * 前端把文件上传后，会在消息的 additional_kwargs.files 里带上文件元数据。
 * 这个中间件把文件信息格式化为 <uploaded_files> 块，拼接到最后一条用户消息前面，
 * 让 LLM 知道有哪些文件可用、文件结构是怎样的。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { getPaths } from "../../config/paths.js";
import { getEffectiveUserId } from "../../runtime/user_context.js";
import { ORIGINAL_USER_CONTENT_KEY, messageContentToText } from "../../utils/messages.js";
import { type ThreadDataState } from "../../agents/thread_state.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 每个上下文块最大文件数 */
const _MAX_FILES_PER_CONTEXT_SECTION = 10;

/** 预览行数 */
const _OUTLINE_PREVIEW_LINES = 5;

/** 最大大纲条目数 */
const _MAX_OUTLINE_ENTRIES = 50;

/** 粗体标题正则（SEC 文档风格：**ITEM 1. BUSINESS**） */
const _BOLD_HEADING_RE = /^\*\*((?:ITEM|PART|SECTION|SCHEDULE|EXHIBIT|APPENDIX|ANNEX|CHAPTER)\b[A-Z0-9 .,\-]*)\*\*\s*$/;

/** 拆分粗体标题正则（学术论文风格：**1** **Introduction**） */
const _SPLIT_BOLD_HEADING_RE = /^\*\*[\dA-Z][\d\.]*\*\*\s+\*\*(?!\d[\d\s.,\-–—/:()%]*\*\*)[^*]+\*\*(?:\s+\*\*[^*]+\*\*){0,2}\s*$/;

/**
 * 清理标题中的粗体标记（** → 空）。
 */
function _cleanBoldTitle(raw: string): string {
    return raw.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** 上传暂存文件标记 */
const _UPLOAD_STAGING_PREFIX = ".upload-";
const _UPLOAD_STAGING_SUFFIX = ".part";

/** Token 提取正则 */
const _QUERY_TOKEN_RE = /[a-z0-9]+/g;

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

function _isUploadStagingFile(filename: string): boolean {
    return filename.startsWith(_UPLOAD_STAGING_PREFIX) && filename.endsWith(_UPLOAD_STAGING_SUFFIX);
}

function _extensionLabel(file: Record<string, unknown>): string {
    const filename = (file.filename as string) ?? "";
    const ext = (file.extension as string) ?? extname(filename).toLowerCase();
    return ext || "(no extension)";
}

function _formatOmittedFileTypes(files: Array<Record<string, unknown>>): string {
    const counts = new Map<string, number>();
    for (const f of files) {
        const label = _extensionLabel(f);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([ext, count]) => `${count} ${ext}`);
    return parts.join(", ");
}

/**
 * 计算文件与用户查询的匹配强度。
 * 3=精确匹配, 2=文件名分词匹配, 1=扩展名匹配, 0=不匹配
 */
function _queryMatchStrength(file: Record<string, unknown>, queryText: string): number {
    const query = queryText.toLowerCase();
    if (!query) return 0;

    const filename = String(file.filename ?? "").toLowerCase();
    const stem = filename.replace(/\.[^.]+$/, ""); // 去掉扩展名
    const extensionLabel = _extensionLabel(file);
    const extension = extensionLabel.startsWith(".") ? extensionLabel.slice(1) : "";

    if (filename && query.includes(filename)) return 3;
    if (stem.length >= 3 && query.includes(stem)) return 3;

    let tokenMatch = false;
    const re = new RegExp(_QUERY_TOKEN_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(stem)) !== null) {
        if (m[0].length >= 3 && query.includes(m[0])) {
            tokenMatch = true;
            break;
        }
    }
    if (tokenMatch) return 2;

    if (extension && new RegExp(`\\b${extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i").test(query)) {
        return 1;
    }
    return 0;
}

/**
 * 从 .md 文件提取文档大纲（标题列表）。
 *
 * 识别三种标题格式（pymupdf4llm 输出风格）：
 *   1. 标准 Markdown # 标题： # 销售数据
 *   2. 纯粗体标题： **ITEM 1. BUSINESS**（SEC 文件风格）
 *   3. 拆分粗体标题： **1** **Introduction**（学术论文风格）
 */
function _extractOutline(mdPath: string): Array<Record<string, unknown>> {
    if (!existsSync(mdPath)) return [];

    try {
        const content = readFileSync(mdPath, "utf-8");
        const lines = content.split("\n");
        const outline: Array<Record<string, unknown>> = [];

        for (let i = 0; i < lines.length; i++) {
            const stripped = lines[i].trim();
            if (!stripped) continue;

            let title: string | null = null;

            // Style 1: 标准 Markdown 标题
            if (stripped.startsWith("#")) {
                title = _cleanBoldTitle(stripped.replace(/^#+\s*/, ""));
            }
            // Style 2: 纯粗体标题（SEC 文档风格）
            else {
                const boldMatch = _BOLD_HEADING_RE.exec(stripped);
                if (boldMatch) {
                    title = boldMatch[1].trim();
                }
                // Style 3: 拆分粗体标题（学术论文风格）
                else if (_SPLIT_BOLD_HEADING_RE.test(stripped)) {
                    const parts = stripped.match(/\*\*([^*]+)\*\*/g);
                    if (parts) {
                        title = parts.map((p) => p.replace(/\*\*/g, "").trim()).join(" ");
                    }
                }
            }

            if (title) {
                outline.push({ title, line: i + 1 });
            }

            if (outline.length > _MAX_OUTLINE_ENTRIES) {
                outline.pop();
                outline.push({ truncated: true });
                break;
            }
        }

        return outline;
    } catch {
        return [];
    }
}

/**
 * 提取文件大纲和预览。
 */
function _extractOutlineForFile(filePath: string): [Array<Record<string, unknown>>, string[]] {
    const mdPath = filePath.replace(/\.[^.]+$/, ".md");
    if (!existsSync(mdPath)) return [[], []];

    const outline = _extractOutline(mdPath);
    if (outline.length > 0) return [outline, []];

    // 没有标题时读前几行作为预览
    const preview: string[] = [];
    try {
        const content = readFileSync(mdPath, "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
            const s = line.trim();
            if (s) preview.push(s);
            if (preview.length >= _OUTLINE_PREVIEW_LINES) break;
        }
    } catch { /* ignore */ }
    return [[], preview];
}

// ════════════════════════════════════════════════════════════════════════════════
// 文件列表格式化
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 格式化文件条目。
 */
function _formatFileEntry(file: Record<string, unknown>, lines: string[]): void {
    const size = (file.size as number) ?? 0;
    const sizeKb = size / 1024;
    const sizeStr = sizeKb < 1024 ? `${sizeKb.toFixed(1)} KB` : `${(sizeKb / 1024).toFixed(1)} MB`;

    lines.push(`- ${file.filename} (${sizeStr})`);
    lines.push(`  Path: ${file.path}`);

    if (file.selection_reason === "query_match") {
        lines.push("  Selected because: matched the current query.");
    }

    const outline = (file.outline as Array<Record<string, unknown>>) ?? [];
    if (outline.length > 0) {
        const visible = outline.filter((e) => !e.truncated);
        lines.push("  Document outline (use `read_file` with line ranges to read sections):");
        for (const entry of visible) {
            lines.push(`    L${entry.line}: ${entry.title}`);
        }
        if (outline.some((e) => e.truncated)) {
            lines.push(`    ... (showing first ${visible.length} headings; use \`read_file\` to explore further)`);
        }
    } else {
        const preview = (file.outline_preview as string[]) ?? [];
        if (preview.length > 0) {
            lines.push("  No structural headings detected. Document begins with:");
            for (const text of preview) {
                lines.push(`    > ${text}`);
            }
        }
        lines.push("  Use `grep` to search for keywords (e.g. `grep(pattern='keyword', path='/mnt/user-data/uploads/')`).");
    }
    lines.push("");
}

/**
 * 选择要放入上下文的文件，优先匹配当前查询的文件。
 */
function _selectFilesForContext(
    files: Array<Record<string, unknown>>,
    queryText: string,
    recencyKey?: string,
): [Array<Record<string, unknown>>, Array<Record<string, unknown>>] {
    const ranked: Array<{ sortKey: unknown[]; file: Record<string, unknown> }> = [];

    for (let i = 0; i < files.length; i++) {
        const selectedFile = { ...files[i] };
        const matchStrength = _queryMatchStrength(selectedFile, queryText);
        if (matchStrength > 0) {
            selectedFile.selection_reason = "query_match";
        }

        let sortKey: unknown[];
        if (recencyKey) {
            sortKey = [-matchStrength, -((selectedFile[recencyKey] as number) ?? 0), selectedFile.filename as string];
        } else {
            sortKey = [-matchStrength, i];
        }
        ranked.push({ sortKey, file: selectedFile });
    }

    // 按 sortKey 排序（数组比较需要逐个元素比）
    ranked.sort((a, b) => {
        for (let i = 0; i < Math.min(a.sortKey.length, b.sortKey.length); i++) {
            const va = a.sortKey[i] as number;
            const vb = b.sortKey[i] as number;
            if (va !== vb) return va - vb;
        }
        return 0;
    });

    const selected = ranked.slice(0, _MAX_FILES_PER_CONTEXT_SECTION).map((r) => r.file);
    const omitted = ranked.slice(_MAX_FILES_PER_CONTEXT_SECTION).map((r) => r.file);
    return [selected, omitted];
}

/**
 * 创建 <uploaded_files> 块。
 */
function _createFilesMessage(
    newFiles: Array<Record<string, unknown>>,
    historicalFiles: Array<Record<string, unknown>>,
    omittedNewFiles?: Array<Record<string, unknown>> | null,
    omittedHistoricalFiles?: Array<Record<string, unknown>> | null,
): string {
    const lines: string[] = [];
    lines.push("<uploaded_files>");
    lines.push("");
    lines.push("The following files were uploaded in this message:");
    lines.push("");

    if (newFiles.length > 0) {
        for (const file of newFiles) _formatFileEntry(file, lines);
        if (omittedNewFiles && omittedNewFiles.length > 0) {
            lines.push(`... (${omittedNewFiles.length} more file(s) from this message omitted from this context.)`);
            lines.push(`  Omitted file types: ${_formatOmittedFileTypes(omittedNewFiles)}`);
            lines.push("  Use `glob(pattern='**/*', path='/mnt/user-data/uploads/')` to list all uploads.");
            lines.push("  Use `grep(pattern='keyword', path='/mnt/user-data/uploads/')` to search across uploads.");
            lines.push("");
        }
    } else {
        lines.push("(empty)");
        lines.push("");
    }

    if (historicalFiles.length > 0) {
        lines.push("The following files were uploaded in previous messages and are still available:");
        lines.push("");
        for (const file of historicalFiles) _formatFileEntry(file, lines);
        if (omittedHistoricalFiles && omittedHistoricalFiles.length > 0) {
            lines.push(`... (${omittedHistoricalFiles.length} more historical file(s) omitted from this context.)`);
            lines.push(`  Omitted file types: ${_formatOmittedFileTypes(omittedHistoricalFiles)}`);
            lines.push("  Use `glob(pattern='**/*', path='/mnt/user-data/uploads/')` to list all uploads.");
            lines.push("  Use `grep(pattern='keyword', path='/mnt/user-data/uploads/')` to search across uploads.");
            lines.push("");
        }
    }

    lines.push("To work with these files:");
    lines.push("- Read from the file first — use the outline line numbers and `read_file` to locate relevant sections.");
    lines.push("- Use `grep` to search for keywords when you are not sure which section to look at");
    lines.push("  (e.g. `grep(pattern='revenue', path='/mnt/user-data/uploads/')`).");
    lines.push("- Use `glob` to find files by name pattern");
    lines.push("  (e.g. `glob(pattern='**/*.md', path='/mnt/user-data/uploads/')`).");
    lines.push("- Only fall back to web search if the file content is clearly insufficient to answer the question.");
    lines.push("</uploaded_files>");

    return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════════
// 文件元数据提取
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 从消息 additional_kwargs.files 中提取文件列表。
 */
function _filesFromKwargs(
    additionalKwargs: Record<string, unknown> | undefined | null,
    uploadsDir?: string | null,
): Array<Record<string, unknown>> | null {
    if (!additionalKwargs) return null;
    const kwargsFiles = additionalKwargs.files;
    if (!Array.isArray(kwargsFiles) || kwargsFiles.length === 0) return null;

    const files: Array<Record<string, unknown>> = [];
    for (const f of kwargsFiles) {
        if (!f || typeof f !== "object") continue;
        const file = f as Record<string, unknown>;
        const filename = String(file.filename ?? "");
        if (!filename || filename.includes("/") || filename.includes("\\")) continue;
        if (_isUploadStagingFile(filename)) continue;
        if (uploadsDir && !existsSync(join(uploadsDir, filename))) continue;

        files.push({
            filename,
            size: Number(file.size ?? 0),
            path: `/mnt/user-data/uploads/${filename}`,
            extension: extname(filename).toLowerCase(),
        });
    }

    return files.length > 0 ? files : null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 上传文件中间件入口。
 *
 * 扫描当前消息 additional_kwargs.files 中的上传文件，
 * 以及线程 uploads 目录中的历史文件，
 * 构建 <uploaded_files> 块拼接到最后一条用户消息前面。
 *
 * @param messages 当前消息列表
 * @param threadId 线程 ID（用于定位 uploads 目录）
 * @param context 运行时上下文
 * @param threadData 线程数据（含 uploads_path）
 * @returns state 更新或 null（无需更新）
 */
export function setupUploads(
    messages: Array<Record<string, unknown>>,
    options: {
        threadId?: string | null;
        context?: Record<string, unknown> | null;
        threadData?: ThreadDataState | null;
    },
): Record<string, unknown> | null {
    const { threadId, threadData: _threadData } = options;

    if (!messages || messages.length === 0) return null;

    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    if (lastMsg.type !== "human") return null;

    // 解析 uploads 目录
    const paths = getPaths();
    const userId = getEffectiveUserId();
    const uploadsDir = threadId ? paths.sandboxUploadsDir(threadId, userId) : null;

    // 从 additional_kwargs 中提取用户原始查询
    const additionalKwargs = (lastMsg.additional_kwargs as Record<string, unknown>) ?? {};
    const queryText = (additionalKwargs[ORIGINAL_USER_CONTENT_KEY] as string) ?? "";

    // 提取当前消息中的新文件
    const newFiles = _filesFromKwargs(additionalKwargs, uploadsDir) ?? [];
    const [contextNewFiles, omittedNewFiles] = _selectFilesForContext(newFiles, queryText);

    // 收集历史文件（排除新文件）
    const newFilenames = new Set(newFiles.map((f) => f.filename as string));
    const historicalCandidates: Array<Record<string, unknown>> = [];

    if (uploadsDir && existsSync(uploadsDir)) {
        const entries = readdirSync(uploadsDir).sort();
        for (const name of entries) {
            if (_isUploadStagingFile(name)) continue;
            if (newFilenames.has(name)) continue;
            const fullPath = join(uploadsDir, name);
            try {
                const stat = statSync(fullPath);
                if (stat.isFile()) {
                    historicalCandidates.push({
                        filename: name,
                        size: stat.size,
                        path: `/mnt/user-data/uploads/${name}`,
                        extension: extname(name).toLowerCase(),
                        _mtime: stat.mtimeMs,
                        _host_path: fullPath,
                    });
                }
            } catch { /* skip */ }
        }
    }

    const [historicalFiles, omittedHistoricalFiles] = _selectFilesForContext(
        historicalCandidates,
        queryText,
        "_mtime",
    );

    // 提取历史文件的大纲
    for (const file of historicalFiles) {
        const hostPath = file._host_path as string;
        delete file._host_path;
        delete file._mtime;
        const [outline, preview] = _extractOutlineForFile(hostPath);
        file.outline = outline;
        file.outline_preview = preview;
    }

    // 提取新文件的大纲
    if (uploadsDir) {
        for (const file of contextNewFiles) {
            const physPath = join(uploadsDir, file.filename as string);
            const [outline, preview] = _extractOutlineForFile(physPath);
            file.outline = outline;
            file.outline_preview = preview;
        }
    }

    if (contextNewFiles.length === 0 && historicalFiles.length === 0) return null;

    // 构建 <uploaded_files> 块
    const filesMessage = _createFilesMessage(contextNewFiles, historicalFiles, omittedNewFiles, omittedHistoricalFiles);

    // 拼接到最后一条用户消息前面
    const content = lastMsg.content;
    let updatedContent: unknown;

    if (typeof content === "string") {
        updatedContent = `${filesMessage}\n\n${content}`;
    } else if (Array.isArray(content)) {
        const filesBlock = { type: "text", text: `${filesMessage}\n\n` };
        updatedContent = [filesBlock, ...content];
    } else {
        updatedContent = content;
    }

    // 确保 ORIGINAL_USER_CONTENT_KEY 存在
    const preservedKwargs: Record<string, unknown> = { ...additionalKwargs };
    const originalContent = preservedKwargs[ORIGINAL_USER_CONTENT_KEY];
    if (typeof originalContent !== "string") {
        preservedKwargs[ORIGINAL_USER_CONTENT_KEY] = messageContentToText(content);
    }

    const updatedMessages = [...messages];
    updatedMessages[lastIdx] = {
        ...lastMsg,
        content: updatedContent,
        additional_kwargs: preservedKwargs,
    };

    return {
        uploaded_files: newFiles,
        messages: updatedMessages,
    };
}
