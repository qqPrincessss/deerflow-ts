/**
 * 序列化工具 — 把 LangChain 对象转成可 JSON 序列化的格式。
 *
 * 对应原项目：backend/packages/harness/deerflow/runtime/serialization.py
 */

/**
 * 递归序列化 LangChain 对象。
 *
 * 不管输入是什么，输出一定是"可以 JSON.stringify 的东西"。
 */
export function serializeLcObject(obj: unknown): unknown {
    if (obj === null) return null;
    if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map((item) => serializeLcObject(item));
    }
    if (typeof obj === "object") {
        // Interrupt 是 __slots__ 类，没有 model_dump/dict/__dict__
        // 需要特殊处理，否则会走到 str() 产生错误的 payload
        if (obj && "value" in obj && "id" in obj && obj.constructor?.name === "Interrupt") {
            return serializeLcObject({
                value: (obj as Record<string, unknown>).value,
                id: (obj as Record<string, unknown>).id,
            });
        }
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            result[key] = serializeLcObject(value);
        }
        return result;
    }
    return String(obj);
}

/**
 * 序列化 channel values，去掉内部 LangGraph key。
 */
export function serializeChannelValues(channelValues: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(channelValues)) {
        if (key.startsWith("__pregel_")) continue;
        result[key] = serializeLcObject(value);
    }
    return result;
}

/**
 * 去掉 hide_from_ui 消息中的 base64 图片数据。
 */
export function stripDataUrlImageBlocks(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return messages.map((msg) => {
        if (!msg || typeof msg !== "object") return msg;
        const kwargs = msg.additional_kwargs as Record<string, unknown> | undefined;
        if (!kwargs?.hide_from_ui) return msg;
        const content = msg.content;
        if (!Array.isArray(content)) return msg;
        const filtered = content.filter((block: unknown) => {
            if (!block || typeof block !== "object") return true;
            const obj = block as Record<string, unknown>;
            if (obj.type !== "image_url") return true;
            const imageUrl = obj.image_url as Record<string, unknown> | undefined;
            if (!imageUrl?.url || typeof imageUrl.url !== "string") return true;
            return !imageUrl.url.startsWith("data:");
        });
        return { ...msg, content: filtered };
    });
}

/**
 * 序列化 channel values 并去掉 base64 图片数据。
 */
export function serializeChannelValuesForApi(channelValues: Record<string, unknown>): Record<string, unknown> {
    const result = serializeChannelValues(channelValues);
    if (Array.isArray(result.messages)) {
        result.messages = stripDataUrlImageBlocks(result.messages as Array<Record<string, unknown>>);
    }
    return result;
}

/**
 * 序列化 messages-mode tuple (chunk, metadata)。
 */
export function serializeMessagesTuple(obj: unknown): unknown {
    if (Array.isArray(obj) && obj.length === 2) {
        const [chunk, metadata] = obj;
        return [serializeLcObject(chunk), typeof metadata === "object" && metadata !== null ? metadata : {}];
    }
    return serializeLcObject(obj);
}

/**
 * 序列化 LangChain 对象，根据模式选择不同的处理方式。
 */
export function serialize(obj: unknown, mode: string = ""): unknown {
    if (mode === "messages") return serializeMessagesTuple(obj);
    if (mode === "values") {
        if (typeof obj === "object" && obj !== null) {
            return serializeChannelValuesForApi(obj as Record<string, unknown>);
        }
        return serializeLcObject(obj);
    }
    return serializeLcObject(obj);
}
