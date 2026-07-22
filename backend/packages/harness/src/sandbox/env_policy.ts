/**
 * 沙箱命令执行的环境变量策略（issue #3861）。
 *
 * 技能脚本作为沙箱子进程运行。默认情况下，子进程继承 Gateway 进程的整个
 * os.environ——这包含平台凭证（OPENAI_API_KEY、追踪密钥、社区提供者密钥...）。
 * 这使得任何作用域限定的请求密钥注入变得毫无意义：脚本可以直接读取这些
 * 继承的平台密钥。此模块在请求作用域密钥叠加之前，从继承的环境中清除
 * 看起来像密钥的变量。
 *
 * 模式集镜像了 codex 的 *KEY* / *SECRET* / *TOKEN* 默认排除项和 hermes 的
 * 固定提供者阻止列表；与 codex（默认*关闭*排除）不同，DeerFlow 默认*开启*
 * 清除——安全第一。
 */

// 用于密钥型变量名的通配符模式（大小写不敏感）。匹配时变量名转大写。
// 良性的系统变量（PATH、HOME、SHELL、LANG、PWD、TMPDIR、VIRTUAL_ENV、
// PYTHONPATH...）不包含这些标记，因此被保留。
//
// *PASS* 涵盖完整的 PASSWORD/PASSWD 拼写*以及*普遍的缩写形式
//（DB_PASS、SMTP_PASS、MYSQL_PASS...），其纯文本值就是密码本身。
// 它还覆盖了 PGPASSFILE（libpq 的 .pgpass 定位器）。
// 它有意也捕获 *_ASKPASS 凭证助手（GIT_ASKPASS、SSH_ASKPASS、
// SUDO_ASKPASS）。那些命名的是一个*程序*而不是密钥，但那个程序
// 的存在就是为了向调用者提供凭证——继承这个指针与此模块关闭的
// 泄漏类别相同，所以清除它们是故意的，不是附带的。
// 仅仅包含 PASS 的附带名称（COMPASS_*、BYPASS_*）也被清除。
// 对于此模块来说，这是失效安全方向：真正需要任何被清除名称的技能
// 通过 required-secrets 声明它。良性的 PWD/OLDPWD 不携带 PASS 子串，
// 不受影响。
const _SECRET_NAME_PATTERNS = [
    "*KEY*", "*SECRET*", "*TOKEN*", "*PASS*",
    "*CREDENTIAL*", "*DSN*",
];

// 连接字符串/凭证型变量名，不携带 KEY/SECRET/TOKEN/DSN 子串但例行嵌入密码
//（例如 postgresql://user:pw@host/db）。有意避免全局 *URL* 阻止——
// 那会清除技能可以合法读取的良性服务 URL。
// 真正需要其中一个的技能必须通过 required-secrets 声明它
//（调用者然后通过 context.secrets 提供它，注入获胜）。
//
// 同样的推理涵盖那些客户端直接读取的凭证来源。
// MYSQL_PWD 和 REDISCLI_AUTH 是 mysql 和 redis-cli 的无标志凭证来源
// 的文档记录。REDIS_AUTH 对任何标准 Redis 客户端都*不是*规范的——
// 防御性地阻止它，因为客户端库和部署 chart 常设置它。
// PGSERVICEFILE 是 Postgres 的类比：libpq 读取它指向的 pg_service.conf
//（可能携带密码字段）而无需标志；它的兄弟 PGPASSFILE 已经被 *PASS* 捕获。
// 这些需要精确条目：PWD/AUTH/SERVICEFILE 不能被通配，
// 因为 *PWD* 会清除 PWD/OLDPWD 且没有共享标记对它们唯一。
//（*PASS* 已覆盖 PGPASSWORD、MYSQL_PASSWORD、DB_PASS、PGPASSFILE...）
const _BLOCKED_EXACT_NAMES = new Set([
    "DATABASE_URL", "DATABASE_URI", "REDIS_URL", "MONGODB_URI",
    "MONGO_URL", "AMQP_URL", "RABBITMQ_URL", "POSTGRES_URL",
    "POSTGRESQL_URL", "MYSQL_URL", "CLICKHOUSE_URL",
    "CONNECTION_STRING", "CONN_STR", "GH_PAT", "GITHUB_PAT",
    "MYSQL_PWD", "REDISCLI_AUTH", "REDIS_AUTH", "PGSERVICEFILE",
]);

/**
 * fnmatch 风格的名称匹配（通配符转正则）。
 */
function fnmatchCase(name: string, pattern: string): boolean {
    const regexStr = pattern
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${regexStr}$`, "i").test(name);
}

/**
 * 返回 True 如果 name 看起来像凭证，不能被沙箱子进程继承。
 */
export function isBlockedEnvName(name: string): boolean {
    const upper = name.toUpperCase();
    if (_BLOCKED_EXACT_NAMES.has(upper)) return true;
    return _SECRET_NAME_PATTERNS.some((pattern) => fnmatchCase(upper, pattern));
}

/**
 * 构建沙箱子进程的环境变量字典。
 *
 * 继承 os.environ 减去任何看起来像密钥的变量，然后叠加
 * 显式注入的请求作用域密钥。注入的密钥即使其名称匹配阻止模式也获胜，
 * 因为注入是上游授权的（技能声明了它，值来自请求，而不是宿主环境）。
 */
export function buildSandboxEnv(injected?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof key === "string" && typeof value === "string" && !isBlockedEnvName(key)) {
            env[key] = value;
        }
    }
    if (injected) {
        Object.assign(env, injected);
    }
    return env;
}
