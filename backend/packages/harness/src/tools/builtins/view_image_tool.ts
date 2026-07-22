/**
 * 查看图片工具 — 读取图片文件并让其可以展示。
 *
 * 对应原项目：backend/packages/harness/deerflow/tools/builtins/view_image_tool.py
 *
 * 只允许查看 /mnt/user-data/workspace、/mnt/user-data/uploads、
 * /mnt/user-data/outputs 下的图片。
 * 存储轻量元数据（mime_type, size, actual_path）到 state，
 * 由中间件按需读取文件内容，避免在 checkpoint 中存储 base64（见 #4138）。
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { VIRTUAL_PATH_PREFIX } from "../../config/paths.js";
import { type Runtime } from "../types.js";
import { type ThreadDataState } from "../../agents/thread_state.js";
import {
    validateLocalToolPath,
    resolveAndValidateUserDataPath,
    getThreadData,
    maskLocalPathsInOutput,
} from "../../sandbox/tools.js";

const _ALLOWED_IMAGE_VIRTUAL_ROOTS = [
    `${VIRTUAL_PATH_PREFIX}/workspace`,
    `${VIRTUAL_PATH_PREFIX}/uploads`,
    `${VIRTUAL_PATH_PREFIX}/outputs`,
];
const _ALLOWED_IMAGE_VIRTUAL_ROOTS_TEXT = _ALLOWED_IMAGE_VIRTUAL_ROOTS.join(", ");
const _MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const _EXTENSION_TO_MIME: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

function _isAllowedImageVirtualPath(imagePath: string): boolean {
    return _ALLOWED_IMAGE_VIRTUAL_ROOTS.some(
        (root) => imagePath === root || imagePath.startsWith(`${root}/`),
    );
}

function _detectImageMime(imageData: Buffer): string | null {
    // JPEG: starts with FF D8 FF
    if (imageData[0] === 0xff && imageData[1] === 0xd8 && imageData[2] === 0xff) {
        return "image/jpeg";
    }
    // PNG: starts with 89 50 4E 47 0D 0A 1A 0A
    if (
        imageData[0] === 0x89 && imageData[1] === 0x50 && imageData[2] === 0x4e &&
        imageData[3] === 0x47 && imageData[4] === 0x0d && imageData[5] === 0x0a &&
        imageData[6] === 0x1a && imageData[7] === 0x0a
    ) {
        return "image/png";
    }
    // WEBP: RIFF....WEBP
    if (imageData.length >= 12 &&
        imageData[0] === 0x52 && imageData[1] === 0x49 && imageData[2] === 0x46 && imageData[3] === 0x46 &&
        imageData[8] === 0x57 && imageData[9] === 0x45 && imageData[10] === 0x42 && imageData[11] === 0x50
    ) {
        return "image/webp";
    }
    return null;
}

function _sanitizeImageError(error: Error, threadData: ThreadDataState | null): string {
    return maskLocalPathsInOutput(`${error.constructor.name}: ${error.message}`, threadData);
}

/**
 * 读取图片文件并让其可以展示。
 *
 * 调用时机：
 * - 需要查看图片文件内容时
 *
 * 不支持：
 * - 非图片文件（应使用 present_files）
 * - 一次查看多个文件（应使用 present_files）
 *
 * @param imagePath 图片的 /mnt/user-data 虚拟路径，支持 jpg/jpeg/png/webp
 * @returns 操作结果字符串
 */
export function viewImageTool(
    runtime: Runtime,
    imagePath: string,
): string {
    // 检查路径是否允许
    if (!_isAllowedImageVirtualPath(imagePath)) {
        return `Error: Only image paths under ${_ALLOWED_IMAGE_VIRTUAL_ROOTS_TEXT} are allowed`;
    }

    const threadData = getThreadData(runtime);

    let actualPath: string;
    try {
        validateLocalToolPath(imagePath, threadData, true);
        actualPath = resolveAndValidateUserDataPath(imagePath, threadData!);
    } catch (error) {
        return `Error: ${(error as Error).message}`;
    }

    // 检查文件是否存在
    if (!existsSync(actualPath)) {
        return `Error: Image file not found: ${imagePath}`;
    }

    // 检查是否文件（非目录）
    const stat = statSync(actualPath, { throwIfNoEntry: false });
    if (!stat) {
        return `Error: Image file not found: ${imagePath}`;
    }
    if (!stat.isFile()) {
        return `Error: Path is not a file: ${imagePath}`;
    }

    // 检查扩展名
    const ext = extname(actualPath).toLowerCase();
    const expectedMimeType = _EXTENSION_TO_MIME[ext];
    if (!expectedMimeType) {
        const supported = Object.keys(_EXTENSION_TO_MIME).join(", ");
        return `Error: Unsupported image format: ${ext}. Supported formats: ${supported}`;
    }

    // 检查大小
    const imageSize = stat.size;
    if (imageSize > _MAX_IMAGE_BYTES) {
        return `Error: Image file is too large: ${imageSize} bytes. Maximum supported size is ${_MAX_IMAGE_BYTES} bytes`;
    }

    // 读取文件内容验证 magic bytes
    let imageData: Buffer;
    try {
        imageData = readFileSync(actualPath);
    } catch (error) {
        return `Error reading image file: ${_sanitizeImageError(error as Error, threadData)}`;
    }

    // 文件在 stat 和 read 之间发生变化
    if (imageData.length !== imageSize) {
        return "Error: Image file changed during read";
    }

    // 检测 magic bytes
    const detectedMimeType = _detectImageMime(imageData);
    if (!detectedMimeType) {
        return "Error: File contents do not match a supported image format";
    }

    // Magic bytes 与扩展名不一致
    if (detectedMimeType !== expectedMimeType) {
        return `Error: Image contents are ${detectedMimeType}, but file extension indicates ${expectedMimeType}`;
    }

    const mimeType = detectedMimeType;

    // 只存轻量元数据到 state，不存 base64
    const newViewedImages: Record<string, { mime_type: string; size: number; actual_path: string }> = {
        [imagePath]: {
            mime_type: mimeType,
            size: imageSize,
            actual_path: actualPath,
        },
    };

    // 更新 viewed_images 到 state
    if (runtime.state) {
        const state = runtime.state as any;
        state.viewed_images = { ...(state.viewed_images || {}), ...newViewedImages };
    }

    return "Successfully read image";
}
