/**
 * ISO 8601 时间戳工具函数。
 *
 * 对应原项目：backend/packages/harness/deerflow/utils/time.py
 */

/**
 * 获取当前 UTC 时间的 ISO 8601 字符串。
 *
 * 示例："2026-04-27T03:19:46.511Z"
 */
export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * 判断租约是否已过期。
 *
 * @param leaseExpiresAt 租约过期时间（ISO 8601 字符串）
 * @param graceSeconds 宽限期（秒）
 * @returns 是否已过期
 */
export function isLeaseExpired(leaseExpiresAt: string | null, graceSeconds: number): boolean {
    if (leaseExpiresAt === null) {
        return true;
    }
    try {
        const dt = new Date(leaseExpiresAt);
        if (isNaN(dt.getTime())) {
            return true;
        }
        return dt.getTime() < Date.now() - graceSeconds * 1000;
    } catch {
        return true;
    }
}

/**
 * 将存储的时间戳转换为 ISO 8601 字符串。
 *
 * 兼容旧版本存储的 unix 时间戳（10 位数字）。
 */
export function coerceIso(value: unknown): string {
    if (value === null || value === undefined || value === "") {
        return "";
    }
    if (typeof value === "boolean") {
        return String(value);
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "number") {
        try {
            return new Date(value * 1000).toISOString();
        } catch {
            return String(value);
        }
    }
    if (typeof value === "string") {
        // 检查是否是 unix 时间戳格式（10 位数字）
        if (/^\d{10}(?:\.\d+)?$/.test(value)) {
            try {
                return new Date(parseFloat(value) * 1000).toISOString();
            } catch {
                return value;
            }
        }
        return value;
    }
    return String(value);
}
