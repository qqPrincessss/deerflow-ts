/**
 * MCP OAuth 令牌管理 — 为 MCP HTTP/SSE 服务器提供 OAuth 支持。
 *
 * 对应原项目：backend/packages/harness/deerflow/mcp/oauth.py
 */

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

export interface McpOAuthConfig {
    token_url: string;
    grant_type: "client_credentials" | "refresh_token";
    client_id?: string;
    client_secret?: string;
    refresh_token?: string;
    scope?: string;
    audience?: string;
    token_field?: string;
    token_type_field?: string;
    default_token_type?: string;
    expires_in_field?: string;
    extra_token_params?: Record<string, string>;
    refresh_skew_seconds?: number;
    enabled?: boolean;
}

interface OAuthToken {
    access_token: string;
    token_type: string;
    expires_at: number; // timestamp ms
}

// ════════════════════════════════════════════════════════════════════════════════
// OAuthTokenManager
// ════════════════════════════════════════════════════════════════════════════════

export class OAuthTokenManager {
    private _oauthByServer: Record<string, McpOAuthConfig>;
    private _tokens: Record<string, OAuthToken> = {};
    private _pendingFetches: Record<string, Promise<OAuthToken>> = {};

    constructor(oauthByServer: Record<string, McpOAuthConfig>) {
        this._oauthByServer = oauthByServer;
    }

    hasOAuthServers(): boolean {
        return Object.keys(this._oauthByServer).length > 0;
    }

    oAuthServerNames(): string[] {
        return Object.keys(this._oauthByServer);
    }

    /**
     * 获取 Authorization 头部值（缓存中有效则直接返回，否则刷新）。
     */
    async getAuthorizationHeader(serverName: string): Promise<string | null> {
        const oauth = this._oauthByServer[serverName];
        if (!oauth) return null;

        const token = this._tokens[serverName];
        if (token && !this._isExpiring(token, oauth)) {
            return `${token.token_type} ${token.access_token}`;
        }

        // 防并发
        if (!this._pendingFetches[serverName]) {
            this._pendingFetches[serverName] = this._fetchToken(oauth);
        }

        try {
            const fresh = await this._pendingFetches[serverName];
            this._tokens[serverName] = fresh;
            return `${fresh.token_type} ${fresh.access_token}`;
        } finally {
            delete this._pendingFetches[serverName];
        }
    }

    private _isExpiring(token: OAuthToken, oauth: McpOAuthConfig): boolean {
        const skew = Math.max(oauth.refresh_skew_seconds ?? 60, 0) * 1000;
        return token.expires_at <= Date.now() + skew;
    }

    private async _fetchToken(oauth: McpOAuthConfig): Promise<OAuthToken> {
        const data = new URLSearchParams();
        data.set("grant_type", oauth.grant_type);

        if (oauth.scope) data.set("scope", oauth.scope);
        if (oauth.audience) data.set("audience", oauth.audience);

        if (oauth.extra_token_params) {
            for (const [k, v] of Object.entries(oauth.extra_token_params)) {
                data.set(k, v);
            }
        }

        if (oauth.grant_type === "client_credentials") {
            if (!oauth.client_id || !oauth.client_secret) {
                throw new Error("OAuth client_credentials requires client_id and client_secret");
            }
            data.set("client_id", oauth.client_id);
            data.set("client_secret", oauth.client_secret);
        } else if (oauth.grant_type === "refresh_token") {
            if (!oauth.refresh_token) {
                throw new Error("OAuth refresh_token grant requires refresh_token");
            }
            data.set("refresh_token", oauth.refresh_token);
            if (oauth.client_id) data.set("client_id", oauth.client_id);
            if (oauth.client_secret) data.set("client_secret", oauth.client_secret);
        } else {
            throw new Error(`Unsupported OAuth grant type: ${oauth.grant_type}`);
        }

        const response = await fetch(oauth.token_url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: data.toString(),
        });

        if (!response.ok) {
            throw new Error(`OAuth token request failed: ${response.status} ${response.statusText}`);
        }

        const payload = (await response.json()) as Record<string, unknown>;

        const tokenField = oauth.token_field ?? "access_token";
        const accessToken = payload[tokenField];
        if (!accessToken || typeof accessToken !== "string") {
            throw new Error(`OAuth token response missing '${tokenField}'`);
        }

        // 刷新 refresh_token（如果提供商轮换它）
        if (oauth.grant_type === "refresh_token") {
            const rotated = payload.refresh_token;
            if (typeof rotated === "string" && rotated) {
                oauth.refresh_token = rotated;
            }
        }

        const tokenType = String(payload[oauth.token_type_field ?? "token_type"] ?? oauth.default_token_type ?? "Bearer");
        const expiresInRaw = payload[oauth.expires_in_field ?? "expires_in"] ?? 3600;
        const expiresIn = Math.max(Number(expiresInRaw) || 3600, 1);

        return {
            access_token: accessToken,
            token_type: tokenType,
            expires_at: Date.now() + expiresIn * 1000,
        };
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 初始头部获取
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 获取初始 OAuth Authorization 头部。
 */
export async function getInitialOAuthHeaders(
    oauthByServer: Record<string, McpOAuthConfig>,
): Promise<Record<string, string>> {
    const manager = new OAuthTokenManager(oauthByServer);
    if (!manager.hasOAuthServers()) return {};

    const headers: Record<string, string> = {};
    for (const name of manager.oAuthServerNames()) {
        try {
            const value = await manager.getAuthorizationHeader(name);
            if (value) headers[name] = value;
        } catch {
            // 跳过获取失败的服务器
        }
    }
    return headers;
}
