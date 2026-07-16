/**
 * 扩展配置（MCP 服务器 + 技能）。
 *
 * 对应原项目：backend/packages/harness/deerflow/config/extensions_config.py
 *
 * 统一管理 MCP 服务器和技能的配置。
 */

import { z } from "zod";

/** MCP 路由配置 */
export const McpRoutingConfigSchema = z.object({
    mode: z.enum(["off", "prefer"]).default("off"),
    priority: z.number().min(0).max(100).default(0),
    keywords: z.array(z.string()).default([]),
});
export type McpRoutingConfig = z.infer<typeof McpRoutingConfigSchema>;

/** MCP 工具覆盖配置 */
export const McpToolOverrideSchema = z.object({
    routing: McpRoutingConfigSchema.default({}),
});
export type McpToolOverride = z.infer<typeof McpToolOverrideSchema>;

/** MCP OAuth 配置 */
export const McpOAuthConfigSchema = z.object({
    enabled: z.boolean().default(true),
    token_url: z.string(),
    grant_type: z.enum(["client_credentials", "refresh_token"]).default("client_credentials"),
    client_id: z.string().nullable().default(null),
    client_secret: z.string().nullable().default(null),
    refresh_token: z.string().nullable().default(null),
    scope: z.string().nullable().default(null),
    audience: z.string().nullable().default(null),
    token_field: z.string().default("access_token"),
    token_type_field: z.string().default("token_type"),
    expires_in_field: z.string().default("expires_in"),
    default_token_type: z.string().default("Bearer"),
    refresh_skew_seconds: z.number().default(60),
    extra_token_params: z.record(z.string()).default({}),
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;

/** MCP 服务器配置 */
export const McpServerConfigSchema = z.object({
    enabled: z.boolean().default(true),
    type: z.string().default("stdio"),
    command: z.string().nullable().default(null),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    url: z.string().nullable().default(null),
    headers: z.record(z.string()).default({}),
    oauth: McpOAuthConfigSchema.nullable().default(null),
    description: z.string().default(""),
    routing: McpRoutingConfigSchema.default({}),
    tools: z.record(McpToolOverrideSchema).default({}),
    tool_call_timeout: z.number().nullable().default(null),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** 技能状态配置 */
export const SkillStateConfigSchema = z.object({
    enabled: z.boolean().default(true),
});
export type SkillStateConfig = z.infer<typeof SkillStateConfigSchema>;

/** 扩展配置主 schema */
export const ExtensionsConfigSchema = z.object({
    mcp_servers: z.record(McpServerConfigSchema).default({}),
    skills: z.record(SkillStateConfigSchema).default({}),
});
export type ExtensionsConfig = z.infer<typeof ExtensionsConfigSchema>;
