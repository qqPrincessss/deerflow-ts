
import { statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
interface MemoryStorage {
    /** 加载记忆数据 */
    load(agentName?: string, userId?: string): Record<string, unknown>;
    /** 强制重新加载（忽略缓存） */
    reload(agentName?: string, userId?: string): Record<string, unknown>;
    /** 保存记忆数据 */
    save(memoryData: Record<string, unknown>, agentName?: string, userId?: string): boolean;
}
export function createEmptyMemory(): Record<string, unknown> {
    return {
        version: "1.0",
        lastUpdated: new Date().toISOString(),
        //   workContext — 工作上下文
        //   存什么：用户当前在做什么工作。
        //   例子：
        //   "用户正在开发一个 AI Agent 系统"
        //   "用户在分析销售数据"
        //   "用户在写技术文档"
        //   什么时候更新：用户聊到工作相关的话题时。
        //   注入频率：每次对话都注入。LLM 需要知道"用户在干嘛"才能给出有用的回答。
        //         ---
        //   personalContext — 个人上下文
        //   存什么：用户的个人信息。
        //   例子：
        //   "用户是后端开发工程师"
        //   "用户在北京工作"
        //   "用户偏好 TypeScript"
        //   什么时候更新：用户提到个人信息时。
        //   注入频率：偶尔注入。这些信息变化不频繁，不需要每次都注入。
        //   ---
        //         ---
        //   topOfMind — 最近关注的事

        //   存什么：用户最近在想什么、关注什么。

        //   例子：
        //   "正在学 DeerFlow 架构"
        //   "下周要交报告"
        //   "最近在研究 LangGraph"

        //   什么时候更新：用户提到最近的计划或关注点时。

        //   注入频率：优先注入。这些是"热"信息，用户当前最关心。

        //   ---
        //   一句话总结
        user: {
            workContext: { summary: "", updatedAt: "" },
            personalContext: { summary: "", updatedAt: "" },
            topOfMind: { summary: "", updatedAt: "" },
        },
        //  recentMonths — 最近几个月
        //  earlierContext — 更早的事
        //  longTermBackground — 长期背景

        history: {
            recentMonths: { summary: "", updatedAt: "" },
            earlierContext: { summary: "", updatedAt: "" },
            longTermBackground: { summary: "", updatedAt: "" },
        },
        facts: [],
    }
}
function getMemoryFilePath(agentName?: string, userId?: string): string {
    const baseDir = process.env.DEER_FLOW_HOME || ".deer-flow";

    if (userId && agentName) {
        // 用户 + Agent 的记忆
        return `${baseDir}/users/${userId}/agents/${agentName}/memory.json`;
    }
    if (userId) {
        // 用户全局记忆
        return `${baseDir}/users/${userId}/memory.json`;
    }
    // 全局记忆
    return `${baseDir}/memory.json`;
}

export class FileMemoryStorage implements MemoryStorage {
    constructor() {
        this.cache = new Map();
    }
    private cache: Map<string, { data: Record<string, unknown>, mtime: number | null }>;

    load(agentName?: string, userId?: string): Record<string, unknown> {
        //找文件路径
        const filePath = getMemoryFilePath(agentName, userId);
        //检查文件修改时间
        let mtime: number | null = null;
        try {
            mtime = statSync(filePath).mtimeMs;
        } catch {
            mtime = null;
        }


        //检查查缓存
        const cacheKey = `${userId || ""}:${agentName || ""}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.mtime === mtime) {
            return cached.data;  // 缓存命中！
        }


        //读文件
        let data: Record<string, unknown>;
        try {
            data = JSON.parse(readFileSync(filePath, "utf-8"));
        } catch {
            data = createEmptyMemory();  // 文件不存在，返回空结构
        }
        this.cache.set(cacheKey, { data, mtime });
        return data;
    }

    //强制重新读取
    reload(agentName?: string, userId?: string): Record<string, unknown> {
        const filePath = getMemoryFilePath(agentName, userId);
        const cacheKey = `${userId || ""}:${agentName || ""}`;

        let data: Record<string, unknown>;
        try {
            data = JSON.parse(readFileSync(filePath, "utf-8"));
        } catch {
            data = createEmptyMemory();
        }

        // 更新缓存
        let mtime: number | null = null;
        try { mtime = statSync(filePath).mtimeMs; } catch { mtime = null; }
        this.cache.set(cacheKey, { data, mtime });

        return data;
    }


    save(memoryData: Record<string, unknown>, agentName?: string, userId?: string): boolean {
        const filePath = getMemoryFilePath(agentName, userId);
        const cacheKey = `${userId || ""}:${agentName || ""}`;

        try {
            // 创建目录
            mkdirSync(dirname(filePath), { recursive: true });

            // 更新时间戳
            const dataToSave = { ...memoryData, lastUpdated: new Date().toISOString() };

            // 原子写入（先写临时文件，再 rename）
            const tempPath = `${filePath}.${Date.now()}.tmp`;
            writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), "utf-8");
            renameSync(tempPath, filePath);

            // 更新缓存
            const mtime = statSync(filePath).mtimeMs;
            this.cache.set(cacheKey, { data: dataToSave, mtime });

            return true;
        } catch {
            return false;
        }
    }
}