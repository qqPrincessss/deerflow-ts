/**
 * 有界字典 — 防止内存泄漏的 Map。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/_bounded_dict.py
 *
 * 问题：中间件需要记录每个 run_id 的状态（循环检测、token 预算等）。
 * 如果 run 太多，Map 会无限增长，导致内存泄漏。
 *
 * 解决：限制 Map 大小，超过限制时删除最旧的条目。
 */

/**
 * 有界 Map — 超过 maxsize 时自动删除最旧的条目。
 *
 * 对应原项目的 BoundedDict（OrderedDict + maxsize）。
 */
export class BoundedMap<K, V> extends Map<K, V> {
    private readonly maxSize: number;

    constructor(maxSize: number = 1000) {
        super();
        this.maxSize = maxSize;
    }

    set(key: K, value: V): this {
        // 如果 key 不存在且已满，删除最旧的条目
        if (!this.has(key) && this.size >= this.maxSize) {
            const firstKey = this.keys().next().value;
            if (firstKey !== undefined) {
                this.delete(firstKey);
            }
        }
        return super.set(key, value);
    }
}
