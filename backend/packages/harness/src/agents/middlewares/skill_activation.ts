/**
 * 技能激活中间件 — 斜杠命令 /skill-name 激活 + 密钥绑定。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py
 *
 * 用户输入 /deerflow 时：
 *   1. slash.ts 解析出技能名
 *   2. storage.ts 加载技能列表
 *   3. parser.ts 已通过 storage.loadSkills 读取了 SKILL.md
 *   4. 注入隐藏的激活提醒到消息中
 *   5. 绑定技能需要的请求级密钥
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_SKILLS_CONTAINER_PATH } from "../../constants.js";
import { getOrNewSkillStorage } from "../../skills/storage.js";
import { parseSlashSkillReference, resolveSlashSkill, RESERVED_SLASH_SKILL_NAMES } from "../../skills/slash.js";
import { type Skill, SkillCategory, SKILL_MD_FILE } from "../../skills/types.js";
import { extractRequestSecrets, ACTIVE_SECRETS_CONTEXT_KEY } from "../../runtime/secret_context.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

const _SLASH_SKILL_ACTIVATION_KEY = "slash_skill_activation";
const _SLASH_SKILL_ACTIVATION_TARGET_ID_KEY = "slash_skill_activation_target_id";
const _SLASH_SECRET_SOURCE_KEY = "__slash_skill_secret_source";
const _SECRETS_BINDING_AUDIT_KEY = "__skill_secrets_binding_audit";
const _SLASH_SKILL_ACTIVATION_RUN_KEY = "__slash_skill_activation_run";
const _SKILL_MD_FILE = "SKILL.md";

// ════════════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════════════

interface Activation {
    skillName: string;
    category: string;
    containerFilePath: string;
    skillContent: string;
    contentHash: string;
    remainingText: string;
    editable: boolean;
    requiredSecrets: Array<{ name: string; optional?: boolean }>;
}

interface ActivationResolution {
    activation?: Activation | null;
    failureMessage?: string | null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 检测函数
// ════════════════════════════════════════════════════════════════════════════════

export function isSlashSkillActivationReminder(msg: Record<string, unknown>): boolean {
    if (msg.type !== "human") return false;
    const kwargs = (msg.additional_kwargs as Record<string, unknown>) ?? {};
    return kwargs[_SLASH_SKILL_ACTIVATION_KEY] === true;
}

// ════════════════════════════════════════════════════════════════════════════════
// 读取技能内容
// ════════════════════════════════════════════════════════════════════════════════

function _readSkillContent(skillFile: string): string {
    if (!skillFile.endsWith(_SKILL_MD_FILE)) {
        throw new Error(`Expected ${_SKILL_MD_FILE}, got ${skillFile}`);
    }
    return readFileSync(skillFile, "utf-8");
}

// ════════════════════════════════════════════════════════════════════════════════
// 解析激活
// ════════════════════════════════════════════════════════════════════════════════

function _resolveActivation(
    text: string,
    availableSkills?: Set<string> | null,
): ActivationResolution | null {
    const reference = parseSlashSkillReference(text);
    if (reference === null) return null;

    // 加载所有技能
    let skills: Skill[];
    try {
        const storage = getOrNewSkillStorage();
        skills = storage.loadSkills();
    } catch {
        return { failureMessage: "Failed to load skills." };
    }

    // 找技能
    const resolved = resolveSlashSkill(text, skills, { available_skills: availableSkills });
    if (resolved === null) {
        if (reference.name && !RESERVED_SLASH_SKILL_NAMES.has(reference.name)) {
            return { failureMessage: `Skill \`/${reference.name}\` is not installed.` };
        }
        return null;
    }

    // 读技能内容
    let skillContent: string;
    try {
        skillContent = _readSkillContent(resolved.skill.skill_file);
    } catch {
        return { failureMessage: `Skill \`/${reference.name}\` could not be loaded safely. Please check the skill installation.` };
    }

    const contentHash = createHash("sha256").update(skillContent).digest("hex");
    const editable = resolved.skill.category === SkillCategory.CUSTOM;

    return {
        activation: {
            skillName: resolved.skill.name,
            category: resolved.skill.category,
            containerFilePath: resolved.container_file_path,
            skillContent,
            contentHash,
            remainingText: resolved.remaining_text,
            editable,
            requiredSecrets: resolved.skill.required_secrets ?? [],
        },
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 构建激活提醒
// ════════════════════════════════════════════════════════════════════════════════

function _htmlEscape(text: string, quoteAttr: boolean = false): string {
    let result = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (quoteAttr) result = result.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    return result;
}

function _buildActivationReminder(activation: Activation): string {
    const userRequest = activation.remainingText || "No additional task text was provided after the slash skill command. Ask the user what they want to do with this skill if the next step is unclear.";
    const escapedRequest = _htmlEscape(userRequest);
    const escapedContent = _htmlEscape(activation.skillContent);
    const escapedName = _htmlEscape(activation.skillName, true);
    const escapedCategory = _htmlEscape(activation.category, true);
    const escapedPath = _htmlEscape(activation.containerFilePath, true);
    const escapedHash = _htmlEscape(activation.contentHash, true);
    const editableStr = activation.editable ? "true" : "false";

    return `<slash_skill_activation>
The user explicitly activated the \`${escapedName}\` skill for this turn.
Treat the task text as:
<user_request>
${escapedRequest}
</user_request>

Follow this skill before choosing a general workflow. Load supporting resources from the same skill directory only when needed.

<skill name="${escapedName}" category="${escapedCategory}" path="${escapedPath}" sha256="${escapedHash}" editable="${editableStr}">
<skill_content encoding="xml-escaped">
${escapedContent}
</skill_content>
</skill>
</slash_skill_activation>`;
}

function _makeActivationMessage(
    target: Record<string, unknown>,
    activationContent: string,
): Record<string, unknown> {
    const stableId = (target.id as string) ?? `act_${Date.now()}`;
    const additionalKwargs: Record<string, unknown> = {
        hide_from_ui: true,
        [_SLASH_SKILL_ACTIVATION_KEY]: true,
    };
    if (target.id) {
        additionalKwargs[_SLASH_SKILL_ACTIVATION_TARGET_ID_KEY] = target.id;
    }
    return {
        type: "human",
        content: activationContent,
        id: `${stableId}__slash_activation`,
        additional_kwargs: additionalKwargs,
    };
}

// ════════════════════════════════════════════════════════════════════════════════
// 密钥绑定
// ════════════════════════════════════════════════════════════════════════════════

function _resolveSecretBindings(
    activation: Activation | null,
    context: Record<string, unknown> | undefined,
): void {
    if (!context) return;

    // 记录斜杠激活源
    if (activation) {
        context[_SLASH_SECRET_SOURCE_KEY] = { path: activation.containerFilePath };
    }

    // 提取请求级密钥
    const requestSecrets = extractRequestSecrets(context);
    if (Object.keys(requestSecrets).length === 0) return;

    // 解析激活技能需要的密钥
    const injected: Record<string, string> = {};
    const boundSkills = new Set<string>();
    const missing: Record<string, string[]> = {};

    // 斜杠激活的技能
    if (activation) {
        for (const req of activation.requiredSecrets) {
            if (requestSecrets[req.name]) {
                injected[req.name] = requestSecrets[req.name];
                boundSkills.add(activation.skillName);
            } else if (!req.optional) {
                missing[activation.skillName] = missing[activation.skillName] ?? [];
                missing[activation.skillName].push(req.name);
            }
        }
    }

    // 注入密钥到上下文
    if (Object.keys(injected).length > 0) {
        context[ACTIVE_SECRETS_CONTEXT_KEY] = injected;
    } else {
        delete context[ACTIVE_SECRETS_CONTEXT_KEY];
    }

    // 审计日志
    const auditState = {
        skills: [...boundSkills].sort(),
        secrets: Object.keys(injected).sort(),
        missing: Object.fromEntries(
            Object.entries(missing).map(([k, v]) => [k, [...v].sort()]),
        ),
    };
    context[_SECRETS_BINDING_AUDIT_KEY] = auditState;

    if (Object.keys(missing).length > 0) {
        for (const [skillName, names] of Object.entries(missing)) {
            console.warn(`Skill ${skillName} is active but required secrets are missing: ${names.join(", ")}`);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 处理斜杠技能激活。
 *
 * 在模型调用前调用。
 *
 * @param messages 当前消息列表
 * @param context 运行时上下文（用于密钥注入和去重）
 * @param availableSkills 可用的技能名集合（null 表示全部可用）
 * @returns state 更新或错误消息
 */
export function processSlashSkillActivation(
    messages: Array<Record<string, unknown>>,
    context?: Record<string, unknown> | null,
    availableSkills?: Set<string> | null,
): Record<string, unknown> | null {
    if (!messages || messages.length === 0) return null;

    // 从后往前找最后一条用户消息
    let targetIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === "human" && !isSlashSkillActivationReminder(msg)) {
            targetIdx = i;
            break;
        }
    }
    if (targetIdx === -1) return null;

    const target = messages[targetIdx];

    // 检查是否已有激活提醒
    if (targetIdx > 0 && isSlashSkillActivationReminder(messages[targetIdx - 1])) {
        return null;
    }

    // 检查是否已在本次 run 中激活过
    if (context) {
        const actKey = _activationRunKey(target);
        if (context[_SLASH_SKILL_ACTIVATION_RUN_KEY] === actKey) return null;
    }

    // 获取原始用户文本（跳过边界标记）
    const additionalKwargs = (target.additional_kwargs as Record<string, unknown>) ?? {};
    const originalContent = (additionalKwargs.__original_user_content as string) ?? target.content as string ?? "";
    const text = typeof originalContent === "string" ? originalContent : "";

    // 解析激活
    const resolution = _resolveActivation(text, availableSkills);
    if (resolution === null) return null;

    // 失败消息
    if (resolution.failureMessage) {
        return {
            messages: [
                ...messages,
                { type: "ai", content: resolution.failureMessage },
            ],
        };
    }

    const activation = resolution.activation;
    if (!activation) return null;

    // 记录激活到 context（防止同一次 run 重复激活）
    if (context) {
        const runKey = _activationRunKey(target);
        context[_SLASH_SKILL_ACTIVATION_RUN_KEY] = runKey;
    }

    // 构建激活提醒消息
    const activationContent = _buildActivationReminder(activation);
    const activationMsg = _makeActivationMessage(target, activationContent);

    // 注入到消息列表
    const newMessages = [...messages];
    newMessages.splice(targetIdx, 0, activationMsg);

    // 密钥绑定
    _resolveSecretBindings(activation, context ?? undefined);

    return { messages: newMessages };
}

function _activationRunKey(target: Record<string, unknown>): string {
    if (target.id && typeof target.id === "string") return target.id;
    const content = (target.content as string) ?? "";
    return "sha256:" + createHash("sha256").update(content).digest("hex");
}
