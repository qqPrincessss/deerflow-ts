/**
 * 沙箱配置。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/sandbox_config.py
 *
 * 沙箱是 Agent 执行代码的安全隔离环境。
 * 配置决定用哪种沙箱（本地/Docker/云端）以及各种限制。
 */

import { z } from "zod";

/** 卷挂载配置 */
export const VolumeMountConfigSchema = z.object({
    /** 宿主机路径 */
    host_path: z.string(),
    /** 容器内路径 */
    container_path: z.string(),
    /** 是否只读 */
    read_only: z.boolean().default(false),
});

export type VolumeMountConfig = z.infer<typeof VolumeMountConfigSchema>;

export const SandboxConfigSchema = z.object({
    /** 沙箱提供者类路径 */
    use: z.string().default("deerflow.sandbox.local:LocalSandboxProvider"),

    /** 允许在宿主机直接执行 bash（危险，仅限完全信任的本地环境） */
    allow_host_bash: z.boolean().default(false),

    /** 沙箱镜像（Docker/AIO 镜像或 BoxLite OCI 镜像） */
    image: z.string().nullable().default(null),

    /** 沙箱容器基础端口 */
    port: z.number().nullable().default(null),

    /** 每个 Gateway 进程的最大活跃+预热沙箱数 */
    replicas: z.number().nullable().default(null),

    /** 容器名前缀 */
    container_prefix: z.string().nullable().default(null),

    /** 预热沙箱空闲超时（秒） */
    idle_timeout: z.number().nullable().default(null),

    /** BoxLite 专用：回收跳过窗口（秒） */
    health_check_skip_seconds: z.number().min(0).nullable().default(null),

    /** 卷挂载列表 */
    mounts: z.array(VolumeMountConfigSchema).default([]),

    /** 注入沙箱的环境变量（$ 开头从宿主机解析） */
    environment: z.record(z.string()).default({}),

    /** bash 输出最大字符数（0=禁用截断） */
    bash_output_max_chars: z.number().min(0).default(20000),

    /** read_file 输出最大字符数（0=禁用截断） */
    read_file_output_max_chars: z.number().min(0).default(50000),

    /** ls 输出最大字符数（0=禁用截断） */
    ls_output_max_chars: z.number().min(0).default(20000),

    /** bash 命令最大执行时间（秒） */
    bash_command_timeout: z.number().positive().default(600),

    /** Provisioner API key（K8s 沙箱模式） */
    provisioner_api_key: z.string().nullable().default(null),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
