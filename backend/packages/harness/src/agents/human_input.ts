/**
 * 用户回答结构化数据。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/human_input.py
 *
 * 定义了用户回答的数据结构。当 Agent 问用户问题时，
 * 用户的回答要打包成这个格式传回给 Agent。
 */

export const HUMAN_INPUT_RESPONSE_KEY = "human_input_response";

/** 用户输入文字的回答 */
export interface HumanInputTextResponse {
    version: 1;
    kind: "human_input_response";
    source: string;
    request_id: string;
    response_kind: "text";
    value: string;
}

/** 用户选择选项的回答 */
export interface HumanInputOptionResponse {
    version: 1;
    kind: "human_input_response";
    source: string;
    request_id: string;
    response_kind: "option";
    option_id: string;
    value: string;
}

/** 用户回答的联合类型 */
export type HumanInputResponse = HumanInputTextResponse | HumanInputOptionResponse;

/** 非空字符串校验 */
function _nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 从消息的 additional_kwargs 中读取用户回答。
 *
 * 对应原项目 read_human_input_response。
 */
export function readHumanInputResponse(
    additionalKwargs: Record<string, unknown> | null | undefined
): HumanInputResponse | null {
    if (!additionalKwargs) return null;

    const raw = additionalKwargs[HUMAN_INPUT_RESPONSE_KEY];
    if (!raw || typeof raw !== "object") return null;

    const obj = raw as Record<string, unknown>;
    if (obj.version !== 1 || obj.kind !== "human_input_response") return null;

    const source = _nonEmptyString(obj.source);
    const requestId = _nonEmptyString(obj.request_id);
    const value = _nonEmptyString(obj.value);
    if (!source || !requestId || !value) return null;

    const responseKind = obj.response_kind;
    if (responseKind === "text") {
        return {
            version: 1, kind: "human_input_response", source,
            request_id: requestId, response_kind: "text", value,
        };
    }
    if (responseKind === "option") {
        const optionId = _nonEmptyString(obj.option_id);
        if (!optionId) return null;
        return {
            version: 1, kind: "human_input_response", source,
            request_id: requestId, response_kind: "option", option_id: optionId, value,
        };
    }
    return null;
}
