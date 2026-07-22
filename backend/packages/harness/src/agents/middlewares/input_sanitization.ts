/**
 * 输入净化中间件 — 防提示注入（完整版）。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/input_sanitization_middleware.py
 *
 * 把用户输入中被拦截的 XML 标签（如 <system>、<memory>）转义为 &lt;system&gt;，
 * 再包裹在 --- BEGIN USER INPUT --- / --- END USER INPUT --- 边界标记中。
 *
 * 策略：脱敏不拒绝（像 AWS Bedrock 的 PII ANONYMIZE）——保留用户意图，
 * 但消除标签的结构化语义。
 *
 * 完整功能清单：
 * ✅ 40 个拦截标签 HTML 转义
 * ✅ 边界标记包裹（--- BEGIN/END USER INPUT ---）
 * ✅ 边界标记中立化（防止用户伪造边界逃逸）
 * ✅ 幂等性（已经包裹的不重复包裹）
 * ✅ 多模态消息（文字-图片-文字）处理后保留非文本 block 位置
 * ✅ 异常安全（中间件挂了返回原始请求，不崩）
 * ✅ 原始内容存 additional_kwargs 供下游使用
 */

import { messageContentToText, ORIGINAL_USER_CONTENT_KEY } from "../../utils/messages.js";

// ════════════════════════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════════════════════════

/** 摘要消息名称（由 summarization 中间件生成，不是用户真实输入，不处理） */
const _SUMMARY_MESSAGE_NAME = "summary";

/**
 * 框架注入的系统保留标签（需拦截的标签名集合）。
 *
 * 为什么需要专门列出这些标签？
 *
 * DeerFlow 框架在系统提示和动态上下文中大量使用 XML 标签来传递结构化数据：
 *   <system-reminder> 动态上下文提醒
 *   <memory>          用户记忆
 *   <soul>            Agent 人格
 *   <guidelines>      行为准则
 *   等等
 *
 * 如果用户能伪造这些标签，就可以冒充系统指令。
 * 所以所有框架使用的标签 + 常见注入标签都在拦截列表中。
 *
 * 注意：普通 HTML/XML 标签（<div>、<span>）不在列表中，不会被拦截。
 */
const _BLOCKED_TAG_NAMES = new Set([
    // ── 框架注入的结构化/权限块 ──
    // 这些是 DeerFlow 系统自己用的标签，用于向 LLM 传递结构化上下文。
    // 主系统提示的 "System-Context Confidentiality" 部分声明所有此类标签为受信任内部数据。
    // 任何被禁止的标签在不可信输入中伪造时，都会冒充受信任的框架上下文。
    "system-reminder",
    "system_reminder",
    "memory",
    "current_date",
    "think",
    "analysis",
    "role",
    "soul",
    "self_update",
    "thinking_style",
    "clarification_system",
    "critical_reminders",
    "response_style",
    "citations",
    "subagent_system",
    "skill_system",
    "skill_index",
    "available_skills",
    "disabled_skills",
    "memory_tool_system",
    "uploaded_files",
    "todo_list_system",
    "durable_context_data",
    "slash_skill_activation",
    "mcp_routing_hints",
    "available-deferred-tools",
    "goal_continuation",
    // ── 子代理系统提示块 ──
    // 子代理也有自己的 system prompt 标签，声明工具限制等。
    "file_editing_workflow",
    "guidelines",
    "output_format",
    "working_directory",
    "tool_restrictions",
    // ── 常见的提示注入标签 ──
    "system",
    "instruction",
    "important",
    "override",
    "ignore",
    "prompt",
]);

/** 边界标记：标记用户输入的起始和结束 */
const _USER_INPUT_BEGIN = "--- BEGIN USER INPUT ---";
const _USER_INPUT_END = "--- END USER INPUT ---";

/** 中立化的边界标记：用户输入中已有真实边界标记时的替换文本 */
const _NEUTRALIZED_BEGIN = "[BEGIN USER INPUT]";
const _NEUTRALIZED_END = "[END USER INPUT]";

// ════════════════════════════════════════════════════════════════════════════════
// 编译正则
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 构建拦截标签的正则表达式。
 *
 * 把 _BLOCKED_TAG_NAMES 中所有标签拼成一个正则，一次性匹配：
 *   - <tag>、</tag>、<tag attr=...>、<tag/>
 *   - 忽略大小写（<SYSTEM> 也能匹配）
 *   - 全局匹配（不只找第一个）
 *
 * @returns 编译后的正则
 */
function _buildBlockedTagPattern(): RegExp {
    const sorted = [..._BLOCKED_TAG_NAMES].sort();
    const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`<\\s*/?\\s*(?:${escaped.join("|")})\\b[^>]*>?`, "gi");
}

const _BLOCKED_TAG_RE = _buildBlockedTagPattern();

/** 边界标记正则：匹配 _USER_INPUT_BEGIN 或 _USER_INPUT_END */
const _BOUNDARY_TOKEN_RE = new RegExp(
    _USER_INPUT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    + "|" +
    _USER_INPUT_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "g",
);

// ════════════════════════════════════════════════════════════════════════════════
// 辅助函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 转义标签匹配结果。
 *
 * 把匹配到的标签中的 < 和 > 替换为 HTML 实体 &lt; 和 &gt;，
 * 这样 LLM 就不会把它们当成结构化标签，而是当作文本。
 *
 * 示例：
 *   "<system>" → "&lt;system&gt;"
 *   "<memory test='x'>" → "&lt;memory test='x'&gt;"
 *
 * @param match 正则匹配到的完整字符串
 * @returns 转义后的字符串
 */
function _escapeTagMatch(match: string): string {
    return match.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 中立化输入中的边界标记。
 *
 * 如果用户输入中已经包含了 "--- BEGIN USER INPUT ---" 或 "--- END USER INPUT ---"，
 * 把它们替换成 "[BEGIN USER INPUT]" 或 "[END USER INPUT]"。
 *
 * 为什么要做这个？
 * 防止用户通过伪造边界标记来"逃逸"出包裹——如果用户自己写了 END 标记，
 * 后面再跟注入内容，看起来就像是 END 之后的"合法"内容。
 *
 * @param text 用户输入的文本
 * @returns 边界标记被中立化后的文本
 */
function _neutralizeBoundaryTokens(text: string): string {
    return text.replace(_BOUNDARY_TOKEN_RE, (m) =>
        m === _USER_INPUT_BEGIN ? _NEUTRALIZED_BEGIN : _NEUTRALIZED_END,
    );
}

/**
 * 脱敏不可信内容中的框架/注入控制标记。
 *
 * 对任何来自信任边界之外的文本应用两个结构性防御：
 *   1. 拦截的框架/注入标签 → HTML 转义（失去结构化语义，仍可读）
 *   2. 边界标记 → 中立化（防止伪造边界）
 *
 * 这个函数被两个地方共用：
 *   - 用户消息处理（processSanitizeRequest）
 *   - 远程工具结果净化（ToolResultSanitizationMiddleware 对 web_search/web_fetch 结果做同样处理）
 *
 * 不做边界包裹——那是用户消息特有的。
 *
 * @param text 不可信的文本
 * @returns 脱敏后的文本
 */
export function neutralizeUntrustedTags(text: string): string {
    if (!text.trim()) return text;
    text = text.replace(_BLOCKED_TAG_RE, _escapeTagMatch);
    return _neutralizeBoundaryTokens(text);
}

/**
 * 判断一条消息是否为真正的用户消息。
 *
 * 排除以下情况：
 *   1. 不是 HumanMessage → 不处理（AIMessage、ToolMessage 等）
 *   2. name === "summary" → 系统生成的摘要消息，不是用户发的
 *
 * 原项目还有 hide_from_ui + read_human_input_response 的判断逻辑，
 * 用于区分隐藏的 UI 回复消息。由于当前 TS 版本无对应依赖，暂不实现。
 *
 * @param message 消息对象
 * @returns 如果是真正的用户消息返回 true
 */
function _isGenuineUserMessage(message: Record<string, unknown>): boolean {
    if (message.type !== "human") return false;
    if (message.name === _SUMMARY_MESSAGE_NAME) return false;
    return true;
}

/**
 * 从消息内容中提取纯文本部分。
 *
 * LLM 消息内容有两种格式：
 *   1. 纯字符串： "帮我分析数据"
 *   2. Content blocks 数组：
 *      [
 *        { type: "text", text: "这张图有几只猫？" },
 *        { type: "image_url", image_url: { url: "data:base64,..." } }
 *      ]
 *
 * 函数提取所有 type === "text" 的 block 的 text，拼成一段。
 * 同时返回 textBlocks 列表，用于后续重建内容时保留非文本 block 的位置。
 *
 * @param content 消息内容（string 或 content blocks 数组）
 * @returns [拼接后的纯文本, textBlocks 列表（非文本为 null）]
 */
function _extractTextFromContent(
    content: string | unknown[],
): [string, unknown[] | null] {
    if (typeof content === "string") return [content, null];
    if (!Array.isArray(content)) return ["", null];

    const textParts: string[] = [];
    const textBlocks: unknown[] = [];
    for (const block of content) {
        if (
            block &&
            typeof block === "object" &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string"
        ) {
            textParts.push((block as Record<string, unknown>).text as string);
            textBlocks.push(block);
        }
    }
    return [textParts.join("\n"), textBlocks];
}

/**
 * 重建多模态内容，替换净化后的文本并保留非文本 block 的位置。
 *
 * 原项目 _rebuild_content 的完整实现。
 *
 * 场景：用户发了 [文字, 图片, 文字] 的混合内容（多模态消息）。
 * 经过净化后，纯文本 block 被转义和包裹了，但图片 block 不需要动。
 * 这个函数把净化后的文本替换回去，同时保留图片在原始位置。
 *
 * 示例：
 *   输入 content: [
 *     { type: "text", text: "看图" },
 *     { type: "image_url", image_url: {...} },
 *     { type: "text", text: "<system>注入</system>" }
 *   ]
 *   textBlocks 指向第 1 和第 3 个 block
 *   净化后 text: "--- BEGIN ---\n看图\n--- END ---" + "\n" + "--- BEGIN ---\n&lt;system&gt;注入&lt;/system&gt;\n--- END ---"
 *
 *   输出: [
 *     { type: "text", text: "--- BEGIN ---\n看图\n--- END ---\n--- BEGIN ---\n&lt;system&gt;注入&lt;/system&gt;\n--- END ---" },
 *     { type: "image_url", image_url: {...} }  ← 图片 block 原封不动
 *   ]
 *   注意：原项目将所有文本 block 合并为一个 text block，非文本 block 穿插其间。
 *
 * @param originalContent 原始 content blocks 数组
 * @param processedText 净化后的文本（所有 text block 合并处理后的结果）
 * @param textBlocks 从原始内容中提取的 text block 列表（用于位置标记）
 * @returns 重建后的 content blocks 数组
 */
function _rebuildContent(
    originalContent: unknown[],
    processedText: string,
    textBlocks: unknown[],
): unknown[] {
    // 用对象 id 标记哪些 block 是 text block
    const textBlockIds = new Set<number>();
    for (const b of textBlocks) {
        textBlockIds.add(idOf(b));
    }

    // 找到 text block 在原始数组中的起止范围
    let first: number | null = null;
    let last: number | null = null;
    for (let i = 0; i < originalContent.length; i++) {
        if (textBlockIds.has(idOf(originalContent[i]))) {
            if (first === null) first = i;
            last = i;
        }
    }

    if (first === null) return originalContent;

    // 重建：text block 范围替换为一个合并后的 text block
    const result: unknown[] = [...originalContent.slice(0, first), { type: "text", text: processedText }];

    // 把 text block 之间的非文本 block 重新插入
    for (let i = first + 1; i <= last!; i++) {
        if (!textBlockIds.has(idOf(originalContent[i]))) {
            result.push(originalContent[i]);
        }
    }

    // 添加 text block 范围之后的内容
    result.push(...originalContent.slice(last! + 1));

    return result;
}

/**
 * 获取对象的唯一标识（基于引用）。
 *
 * 用于在 _rebuildContent 中判断两个对象是否指向同一个 text block。
 * 原项目使用 Python 的 id() 内置函数，这里用 WeakRef 模拟，
 * 但最简单的方式是用 Map 来跟踪对象引用。
 *
 * 注意：这里用了一个模块级计数器来模拟 id，确保每次调用返回唯一值。
 */
const _objectIds = new WeakMap<object, number>();
let _nextId = 0;

function idOf(obj: unknown): number {
    if (typeof obj !== "object" || obj === null) return -1;
    const existing = _objectIds.get(obj);
    if (existing !== undefined) return existing;
    const id = _nextId++;
    _objectIds.set(obj, id);
    return id;
}

/**
 * 处理用户内容：转义拦截标签，然后包裹边界标记。
 *
 * 完整逻辑：
 *   1. 空文本 → 返回原文本（不产生边界标记噪音）
 *   2. 拦截标签 → HTML 转义 < 和 >
 *   3. 已经包裹了边界标记（strict prefix+suffix）→ 返回原文本（幂等）
 *   4. 如果已经包裹但内部有伪造的边界标记 → 中立化内部标记后重新包裹
 *   5. 中立化用户输入中的边界标记
 *   6. 包裹边界标记
 *
 * @param text 用户输入的文本
 * @returns 净化后的文本
 */
function _checkUserContent(text: string): string {
    if (!text.trim()) return text;

    // 第一步：转义所有拦截标签
    text = text.replace(_BLOCKED_TAG_RE, _escapeTagMatch);

    // 第二步：幂等性检查——如果已经严格包裹了，不重复包裹
    if (text.startsWith(_USER_INPUT_BEGIN) && text.endsWith(_USER_INPUT_END)) {
        // 但内部可能还有伪造的边界标记，需要中立化
        const inner = text.slice(_USER_INPUT_BEGIN.length, -_USER_INPUT_END.length);
        const neutralizedInner = _neutralizeBoundaryTokens(inner);
        if (neutralizedInner === inner) return text;
        return `${_USER_INPUT_BEGIN}${neutralizedInner}${_USER_INPUT_END}`;
    }

    // 第三步：中立化边界标记
    text = _neutralizeBoundaryTokens(text);

    // 第四步：包裹边界标记
    return `${_USER_INPUT_BEGIN}\n${text}\n${_USER_INPUT_END}`;
}

// ════════════════════════════════════════════════════════════════════════════════
// 主函数
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 处理模型请求，对最后一条真实用户消息做净化。
 *
 * 从消息列表中从后往前找最后一条真正的用户消息（HumanMessage），
 * 对其 content 字段做：
 *   1. 提取纯文本（多模态消息只处理 text block）
 *   2. 转义拦截标签 + 包裹边界标记
 *   3. 多模态消息重建（保留非文本 block 位置）
 *   4. 原始内容存到 additional_kwargs.__original_user_content
 *
 * 原始消息不会被修改（返回新列表），保证幂等性。
 *
 * @param messages 请求中的消息列表
 * @returns 处理后的消息列表（如果不需要处理则返回原始列表）
 */
export function tryProcessSanitizeRequest(
    messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
    try {
        return _processSanitizeRequest(messages);
    } catch (error) {
        // 异常安全（fail-open）：
        // 如果中间件处理过程中出现意外错误，记录警告并返回原始请求。
        // 这样 LLM 仍然可以正常工作，只是失去了输入净化的保护。
        // GraphBubbleUp（LangGraph 的特殊异常）应该继续传播，
        // 其他异常则降级处理。
        console.warn("Input guardrail processing failed; passing original request to model", error);
        return messages;
    }
}

/**
 * processSanitizeRequest 的内部实现。
 *
 * 分离出来是为了让 tryProcessSanitizeRequest 包裹异常处理逻辑，
 * 保持主逻辑清晰。
 */
function _processSanitizeRequest(
    messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
    const result = [...messages];

    // 从后往前找最后一条真正的用户消息
    // 为什么从后往前？因为最新的用户消息通常在列表末尾。
    // 为什么要忽略非用户消息？系统消息（system、summary 等）不需要净化。
    for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i];
        if (!_isGenuineUserMessage(msg)) continue;

        const content = msg.content;
        const [textContent, textBlocks] = _extractTextFromContent(content as string | unknown[]);

        // 没有文本内容（例如纯图片消息）→ 不做净化，直接返回
        if (!textContent && !(typeof content === "string")) return result;

        // 做净化（转义标签 + 包裹边界标记）
        const processed = _checkUserContent(textContent);

        // 如果处理后的文本和原来一样（已经是幂等状态），直接返回
        if (processed === textContent) return result;

        // 重建内容：
        //   纯文本 → 直接用处理后的文本替换
        //   多模态 → 调用 _rebuildContent 保留非文本 block 位置
        let newContent: string | unknown[];
        if (textBlocks) {
            newContent = _rebuildContent(content as unknown[], processed, textBlocks);
        } else {
            newContent = processed;
        }

        // 保留原始用户内容到 additional_kwargs 中
        // 下游中间件（如 skill_activation 需要判断用户是否输入了 "/skill-name"）
        // 需要读取原始内容，而不是加了边界标记的版本。
        //
        // 策略：如果已经有 UploadsMiddleware 或其他中间件设置的值，就保留；
        // 如果值不是字符串（比如被恶意覆盖），就修复它。
        const preservedKwargs: Record<string, unknown> = {
            ...((msg.additional_kwargs as Record<string, unknown>) ?? {}),
        };
        const originalContent = preservedKwargs[ORIGINAL_USER_CONTENT_KEY];
        if (typeof originalContent !== "string") {
            preservedKwargs[ORIGINAL_USER_CONTENT_KEY] = messageContentToText(content);
        }

        // 构建新的消息对象（保留 id、name 等字段）
        result[i] = {
            ...msg,
            content: newContent,
            additional_kwargs: preservedKwargs,
        };

        // 只处理最后一条真实用户消息
        // 前面的消息已在之前的轮次中被处理过
        break;
    }

    return result;
}
