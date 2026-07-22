/**
 * 沙箱安全控制 — host bash 执行开关。
 *
 * 对应原项目：backend/packages/harness/deerflow/sandbox/security.py
 */

import { getAppConfig } from "../config/app_config.js";

const LOCAL_SANDBOX_PROVIDER_MARKERS = [
    "deerflow.sandbox.local:LocalSandboxProvider",
    "deerflow.sandbox.local.local_sandbox_provider:LocalSandboxProvider",
];

export const LOCAL_HOST_BASH_DISABLED_MESSAGE =
    "Host bash execution is disabled for LocalSandboxProvider because it is not a secure " +
    "sandbox boundary. Switch to AioSandboxProvider for isolated bash access, or set " +
    'sandbox.allow_host_bash: true only in a fully trusted local environment.';

export const LOCAL_BASH_SUBAGENT_DISABLED_MESSAGE =
    "Bash subagent is disabled for LocalSandboxProvider because host bash execution is not " +
    "a secure sandbox boundary. Switch to AioSandboxProvider for isolated bash access, or set " +
    'sandbox.allow_host_bash: true only in a fully trusted local environment.';

/**
 * 判断当前沙箱是否是本地沙箱。
 */
export function usesLocalSandboxProvider(config?: unknown): boolean {
    const resolved = config ?? getAppConfig();
    const sandboxCfg = (resolved as Record<string, unknown>).sandbox as Record<string, unknown> | undefined;
    const sandboxUse = String(sandboxCfg?.use ?? "");
    return (
        LOCAL_SANDBOX_PROVIDER_MARKERS.includes(sandboxUse) ||
        (sandboxUse.endsWith(":LocalSandboxProvider") && sandboxUse.includes("deerflow.sandbox.local"))
    );
}

/**
 * 判断是否允许 host bash 执行。
 */
export function isHostBashAllowed(config?: unknown): boolean {
    const resolved = config ?? getAppConfig();
    const sandboxCfg = (resolved as Record<string, unknown>).sandbox as Record<string, unknown> | undefined;
    if (!sandboxCfg) return false;
    if (!usesLocalSandboxProvider(resolved)) return true;
    return Boolean(sandboxCfg.allow_host_bash ?? false);
}
