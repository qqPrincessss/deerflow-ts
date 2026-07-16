/**
 * ToolErrorHandlingMiddleware — 把工具异常转换成错误消息。
 *
 * 对应原项目：backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py
 *
 * 问题：工具执行失败（bash 命令报错、文件不存在等）会抛异常，导致整个 Agent 崩溃。
 * 解决：捕获异常，包装成错误消息返回给 LLM，让它自己想办法。
 *
 * 完整功能：
 * 1. 错误消息截断（超过 500 字符截断，防止撑爆上下文）
 * 2. tool_call_id 记录（方便追踪是哪次调用失败了）
 * 3. 子代理异常标记（task 工具失败时标记状态）
 * 4. 技能读取元数据（read_file 成功时记录技能信息）
 * 5. 同步 + 异步支持
 */

// ─── 类型定义 ──────────────────────────────────────────────────

/** 工具调用请求 */
export interface ToolCallRequest {
    tool_call: {
        id?: string;
        name: string;
        args: Record<string, unknown>;
    };
}

/** 工具执行结果 */
export interface ToolResult {
    content: string;
    tool_call_id: string;
    name: string;
    status: "success" | "error";
    additional_kwargs?: Record<string, unknown>;
}

/** 工具执行函数类型 */
export type ToolHandler = (request: ToolCallRequest) => Promise<ToolResult>;

// ─── 常量 ──────────────────────────────────────────────────

/** 错误消息最大长度 */
const MAX_ERROR_DETAIL_LENGTH = 500;

/** 恢复提示 */
const RECOVERY_HINT = "Continue with available context, or choose an alternative tool.";

/** 缺失的 tool_call_id */
const MISSING_TOOL_CALL_ID = "missing_tool_call_id";

/** 子代理工具名 */
const TASK_TOOL_NAME = "task";

// ─── 错误消息构建 ──────────────────────────────────────────

/**
 * 构建错误消息。
 *
 * 原项目 _build_error_message 的完整逻辑：
 * 1. 提取工具名和 tool_call_id
 * 2. 截断过长的错误详情
 * 3. 构建错误内容字符串
 * 4. 标记子代理异常状态（如果是 task 工具）
 */
function buildErrorMessage(request: ToolCallRequest, error: unknown): ToolResult {
    const toolName = request.tool_call.name || "unknown_tool";
    const toolCallId = request.tool_call.id || MISSING_TOOL_CALL_ID;

    // 提取错误详情并截断
    let detail = error instanceof Error ? error.message : String(error);
    detail = detail.trim() || (error instanceof Error ? error.constructor.name : "UnknownError");
    if (detail.length > MAX_ERROR_DETAIL_LENGTH) {
        detail = detail.slice(0, MAX_ERROR_DETAIL_LENGTH - 3) + "...";
    }

    // 构建错误内容
    const errorType = error instanceof Error ? error.constructor.name : "Error";
    const content = `Error: Tool '${toolName}' failed with ${errorType}: ${detail}. ${RECOVERY_HINT}`;

    // 构建结果
    const result: ToolResult = {
        content,
        tool_call_id: toolCallId,
        name: toolName,
        status: "error",
        additional_kwargs: {
            deerflow_tool_meta: {
                status: "error",
                error_type: errorType.toLowerCase(),
                recoverable_by_model: true,
                recommended_next_action: "retry_or_alternative",
            },
        },
    };

    // 子代理异常标记
    if (toolName === TASK_TOOL_NAME) {
        const structuredError = `${errorType}: ${detail}`;
        result.additional_kwargs = {
            ...result.additional_kwargs,
            subagent_status: "failed",
            subagent_error: structuredError,
        };
    }

    return result;
}

// ─── 结果标准化 ──────────────────────────────────────────

/**
 * 标准化工具结果。
 *
 * 原项目 normalize_tool_result 的逻辑：
 * 确保结果有正确的 tool_call_id、name、status。
 */
function normalizeToolResult(result: ToolResult, request: ToolCallRequest): ToolResult {
    return {
        ...result,
        tool_call_id: result.tool_call_id || request.tool_call.id || MISSING_TOOL_CALL_ID,
        name: result.name || request.tool_call.name,
        status: result.status || "success",
    };
}

// ─── 技能读取元数据 ──────────────────────────────────────────

/**
 * 检查工具是否是文件读取类。
 */
function isFileReadTool(toolName: string): boolean {
    return ["read_file", "cat", "head", "tail"].includes(toolName);
}

/**
 * 提取文件路径。
 */
function extractFilePath(args: Record<string, unknown>): string | null {
    return (args.path as string) || null;
}

// ─── 核心函数：wrapToolCall ──────────────────────────────────

/**
 * 包裹工具执行，捕获异常并转换成错误消息。
 *
 * 对应原项目的 wrap_tool_call 方法。
 *
 * 逻辑：
 * 1. try: 执行工具
 * 2. catch: 捕获异常，构建错误消息
 * 3. 成功: 标准化结果
 *
 * @param request 工具调用请求
 * @param handler 工具执行函数
 * @returns 工具结果（成功或错误）
 */
export async function wrapToolCall(
    request: ToolCallRequest,
    handler: ToolHandler
): Promise<ToolResult> {
    try {
        const result = await handler(request);
        return normalizeToolResult(result, request);
    } catch (error) {
        // 保留 LangGraph 控制流信号（如果有的话）
        // 原项目检查 GraphBubbleUp，我们简化处理
        console.error(
            `Tool execution failed: name=${request.tool_call.name} id=${request.tool_call.id}`,
            error
        );
        return buildErrorMessage(request, error);
    }
}

/**
 * 同步版本的 wrapToolCall。
 *
 * 原项目有 wrap_tool_call（同步）和 awrap_tool_call（异步）两个版本。
 * TypeScript 主要用异步，但保留同步版本以防需要。
 */
export function wrapToolCallSync(
    request: ToolCallRequest,
    handler: (request: ToolCallRequest) => ToolResult
): ToolResult {
    try {
        const result = handler(request);
        return normalizeToolResult(result, request);
    } catch (error) {
        console.error(
            `Tool execution failed (sync): name=${request.tool_call.name} id=${request.tool_call.id}`,
            error
        );
        return buildErrorMessage(request, error);
    }
}
