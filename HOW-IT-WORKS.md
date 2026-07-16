# DeerFlow 完整工作原理

> 从用户输入到收到回复，一步一步走完整个流程。
> 每一步都指向 `C:\Users\Administrator\deer-flow\` 中的真实源码。

---

## 全景图

```
用户在浏览器输入 "帮我写个 Python 脚本分析 CSV"
        ↓
    [前端 Next.js]
        ↓ HTTP POST
    [Nginx :2026]
        ↓ 反向代理
    [Gateway :8001]
        ↓ 创建 Run
    [LangGraph 图]
        ↓
    ┌───────────────────────────────────────────────┐
    │  make_lead_agent() 创建 Agent                  │
    │      ↓                                         │
    │  中间件链 beforeModel（14→15→16→17→22→25）      │
    │      ↓                                         │
    │  LLM 调用（GPT-4o / Claude）                   │
    │      ↓                                         │
    │  中间件链 afterModel（27→28→30→31→32）          │
    │      ↓                                         │
    │  LLM 说要用工具 → 中间件链 wrapToolCall（8→10→11→12→13）│
    │      ↓                                         │
    │  执行工具（bash / read_file / write_file）      │
    │      ↓                                         │
    │  结果返回 LLM → 回到"LLM 调用"                  │
    │      ↓                                         │
    │  LLM 说"完成" → 退出循环                        │
    └───────────────────────────────────────────────┘
        ↓ SSE 流式
    [前端显示回复]
```

---

## 第 1 步：前端发送请求

前端代码在 `frontend/src/core/threads/hooks.ts`。

用户在输入框打字，前端发一个 HTTP POST 请求：

```
POST /api/threads/{thread_id}/runs/stream
Body: {
  "messages": [{"role": "user", "content": "帮我写个 Python 脚本分析 CSV"}],
  "config": {
    "configurable": {
      "model_name": "gpt-4o",
      "thinking_enabled": true,
      "subagent_enabled": true
    }
  }
}
```

前端用 `@langchain/langgraph-sdk` 的 `client.runs.stream()` 方法，接收 SSE 流式事件。

---

## 第 2 步：Gateway 接收请求

Gateway 代码在 `backend/app/gateway/routers/threads.py`。

FastAPI 路由收到请求后：
1. 创建一个 `Run`（运行实例）
2. 调用 `RunManager` 启动 LangGraph 图
3. 返回 SSE 流给前端

关键代码路径：
```
app/gateway/routers/threads.py
  → app/gateway/routers/runs.py
    → deerflow/runtime/runs/worker.py  (RunManager)
```

---

## 第 3 步：创建 Lead Agent

**这是最核心的一步。** 源码在 `backend/packages/harness/deerflow/agents/lead_agent/agent.py`。

入口函数是 `make_lead_agent(config)`（第 421 行）。它做 4 件事：

### 3.1 解析运行时配置

```python
# agent.py 第 434-454 行
cfg = _get_runtime_config(config)
thinking_enabled = cfg.get("thinking_enabled", True)
requested_model_name = cfg.get("model_name") or cfg.get("model")
is_plan_mode = cfg.get("is_plan_mode", False)
subagent_enabled = cfg.get("subagent_enabled", False)
```

从请求的 `config.configurable` 里读出：用哪个模型、开不开推理模式、开不开子代理。

### 3.2 创建 LLM 实例

```python
# agent.py 第 613-614 行
model=create_chat_model(
    name=model_name,
    thinking_enabled=thinking_enabled,
    reasoning_effort=reasoning_effort,
    app_config=resolved_app_config,
    attach_tracing=False
)
```

调用 `deerflow/models/factory.py` 的 `create_chat_model()`。这个函数根据 `config.yaml` 里的 `models` 配置，用**反射**动态加载对应的 LangChain 类：

```yaml
# config.yaml
models:
  - name: gpt-4o
    use: langchain_openai:ChatOpenAI    # ← 这个字符串被 resolve_class() 加载
    model: gpt-4o
    api_key: $OPENAI_API_KEY
```

Python 的 `resolve_class("langchain_openai:ChatOpenAI")` 会：
1. 导入 `langchain_openai` 模块
2. 取出 `ChatOpenAI` 类
3. 用配置参数实例化

### 3.3 加载工具

```python
# agent.py 第 598 行
raw_tools = get_available_tools(
    model_name=model_name,
    groups=agent_config.tool_groups,
    subagent_enabled=subagent_enabled,
    app_config=resolved_app_config
)
```

调用 `deerflow/tools/tools.py` 的 `get_available_tools()`。这个函数组装 4 类工具：

```python
# tools.py 第 15-24 行
BUILTIN_TOOLS = [
    present_file_tool,        # 让用户看到输出文件
    ask_clarification_tool,   # 向用户提问
    review_skill_package,     # 审查技能包
]

SUBAGENT_TOOLS = [
    task_tool,                # 委托子代理
]
```

加上 `config.yaml` 里配置的工具（bash、read_file、write_file 等），加上 MCP 工具，加上社区工具。

**最终的工具列表** = 配置工具 + 内置工具 + MCP 工具 + 社区工具 + 子代理工具。

### 3.4 构建中间件链 + 系统提示

```python
# agent.py 第 616-638 行
middleware=build_middlewares(config, model_name, ...),
system_prompt=apply_prompt_template(subagent_enabled, ...),
```

### 3.5 创建 LangGraph Agent

```python
# agent.py 第 613 行
return create_agent(
    model=model,
    tools=final_tools,
    middleware=middlewares,
    system_prompt=system_prompt,
    state_schema=ThreadState,   # ← 状态定义
)
```

`create_agent()` 是 LangChain 的函数，它创建一个 **ReAct Agent 图**：
```
[START] → [agent] → [tools] → [agent] → [tools] → ... → [END]
```

---

## 第 4 步：中间件链执行（beforeModel）

Agent 图启动后，第一步是执行中间件链的 `beforeModel` 钩子。

中间件链的构建在 `agent.py` 的 `build_middlewares()` 函数（第 238 行）。它先调用共享基础，再追加 lead-only：

```python
# agent.py 第 274 行
middlewares = build_lead_runtime_middlewares(app_config=resolved_app_config)
# 然后逐个追加 14-32 号中间件
```

**执行顺序**（每个中间件做什么）：

### 14. DynamicContextMiddleware
源码：`deerflow/agents/middlewares/dynamic_context_middleware.py`

注入当前日期到第一条用户消息：
```
<system-reminder>
Current date: 2026-07-15
</system-reminder>
```

**为什么不在系统提示里？** 因为系统提示是静态的，可以被 LLM 提供商缓存（prefix cache），省钱。

### 15. SkillActivationMiddleware
源码：`deerflow/agents/middlewares/skill_activation_middleware.py`

检测用户是否以 `/skill-name task` 开头。如果是，加载对应的 `SKILL.md` 注入上下文。

### 16. DurableContextMiddleware
源码：`deerflow/agents/middlewares/durable_context_middleware.py`

捕获子代理委托记录和已加载的技能文件，在上下文压缩时保留这些信息。

### 17. SummarizationMiddleware（可选）
源码：`deerflow/agents/middlewares/summarization_middleware.py`

当 token 数超过阈值，用 LLM 把旧消息压缩成摘要。

### 22. ViewImageMiddleware（可选）
源码：`deerflow/agents/middlewares/view_image_middleware.py`

如果模型支持 vision，把用户上传的图片转成 base64 注入消息。

### 25. SystemMessageCoalescingMiddleware
源码：`deerflow/agents/middlewares/system_message_coalescing_middleware.py`

把多个 SystemMessage 合并成一个。有些 LLM 提供商（vLLM、Anthropic）不接受非开头的 SystemMessage。

---

## 第 5 步：LLM 调用

中间件执行完，LangGraph 把消息历史发给 LLM。

```
发送给 LLM 的内容：
┌─────────────────────────────────────┐
│ SystemMessage:                       │
│ "You are DeerFlow, an AI assistant   │
│  with access to tools..."            │
│                                      │
│ <available_skills>...</available_skills> │
│ <memory>...</memory>                 │
├─────────────────────────────────────┤
│ HumanMessage:                        │
│ "<system-reminder>今天是 2026-07-15</system-reminder>" │
│ "帮我写个 Python 脚本分析 CSV"        │
├─────────────────────────────────────┤
│ Tools: [bash, read_file, write_file, task, ...] │
└─────────────────────────────────────┘
```

LLM（GPT-4o）返回：
```json
{
  "content": "好的，我来帮你写。先看看 CSV 文件的内容。",
  "tool_calls": [{
    "id": "call_abc123",
    "name": "read_file",
    "args": { "path": "/mnt/user-data/uploads/data.csv" }
  }]
}
```

---

## 第 6 步：中间件链执行（afterModel）

LLM 返回后，中间件链的 `afterModel` 钩子执行：

### 27. LoopDetectionMiddleware
源码：`deerflow/agents/middlewares/loop_detection_middleware.py`

检查最近 N 次工具调用是否重复。如果 LLM 一直在调同一个工具，强制停止。

### 28. TokenBudgetMiddleware（可选）
源码：`deerflow/agents/middlewares/token_budget_middleware.py`

检查 token 消耗是否超过预算。

### 30. TerminalResponseMiddleware
源码：`deerflow/agents/middlewares/terminal_response_middleware.py`

如果 LLM 返回空响应，重试一次。

### 32. ClarificationMiddleware
源码：`deerflow/agents/middlewares/clarification_middleware.py`

如果 LLM 调用了 `ask_clarification` 工具，暂停执行，把问题发给用户。

---

## 第 7 步：工具执行（wrapToolCall）

LLM 返回了 `tool_calls`，LangGraph 的 `ToolNode` 开始执行工具。

每个工具调用都经过中间件链的 `wrapToolCall` 钩子：

### 8. LLMErrorHandlingMiddleware
源码：`deerflow/agents/middlewares/llm_error_handling_middleware.py`

捕获 LLM 调用异常，转换成友好的错误消息。

### 10. SandboxAuditMiddleware
源码：`deerflow/agents/middlewares/sandbox_audit_middleware.py`

记录沙箱操作日志（安全审计）。

### 11. ReadBeforeWriteMiddleware
源码：`deerflow/agents/middlewares/read_before_write_middleware.py`

**写文件前必须先读过这个文件。** 防止 LLM 盲写覆盖重要内容。

工作原理：
1. `read_file` 执行时，在 ToolMessage 上打一个内容哈希标记
2. `write_file` 执行前，检查是否有这个标记
3. 没有标记 → 拒绝写入，返回错误让 LLM 先读

### 12. ToolProgressMiddleware（可选）
源码：`deerflow/agents/middlewares/tool_progress_middleware.py`

检测工具是否陷入停滞（反复调用但没有新信息）。

### 13. ToolErrorHandlingMiddleware
源码：`deerflow/agents/middlewares/tool_error_handling_middleware.py`

**最重要的中间件之一。** 把工具异常转换成错误 ToolMessage：

```python
def wrap_tool_call(self, request, handler):
    try:
        result = handler(request)  # 正常执行工具
    except Exception as exc:
        # 异常 → 包装成错误消息 → 返回给 LLM
        return ToolMessage(
            content=f"Error: Tool '{name}' failed: {exc}",
            status="error"
        )
    return normalize_tool_result(result)
```

LLM 看到错误后会自己想办法（重试、换方法、告诉用户）。

---

## 第 8 步：实际的工具执行

中间件链包裹的是真正的工具执行。以 `read_file` 为例：

源码：`deerflow/sandbox/tools.py`

```python
@tool
def read_file(path: str, start_line: int = None, end_line: int = None) -> str:
    """Read the contents of a file."""
    sandbox = get_sandbox()  # 获取当前线程的沙箱
    return sandbox.read_file(path, start_line, end_line)
```

沙箱实现（`deerflow/sandbox/local/`）：
1. 把虚拟路径 `/mnt/user-data/uploads/data.csv` 翻译成物理路径
2. 读取文件内容
3. 返回给工具

---

## 第 9 步：结果返回 LLM

工具执行完，结果作为 ToolMessage 追加到消息历史：

```
messages = [
  HumanMessage("帮我写个 Python 脚本分析 CSV"),
  AIMessage("好的，我来帮你写。先看看 CSV 文件的内容。", tool_calls=[...]),
  ToolMessage("id,name,score\n1,Alice,95\n2,Bob,87\n...", tool_call_id="call_abc123"),
]
```

LangGraph 回到第 5 步，把更新后的消息历史再次发给 LLM。

---

## 第 10 步：LLM 继续决策

LLM 看到 CSV 内容后，决定写文件：

```json
{
  "tool_calls": [{
    "id": "call_def456",
    "name": "write_file",
    "args": {
      "path": "/mnt/user-data/workspace/analyze.py",
      "content": "import pandas as pd\ndf = pd.read_csv('data.csv')\nprint(df.describe())"
    }
  }]
}
```

经过 ReadBeforeWrite 检查（新文件，允许创建）→ 执行 write_file → 结果返回 LLM。

LLM 最终回复：
```
"脚本写好了！文件在 /mnt/user-data/workspace/analyze.py。
要运行一下看看结果吗？"
```

---

## 第 11 步：后处理

LLM 说"完成"，没有 tool_calls，退出循环。

后处理中间件执行：

### 20. TitleMiddleware
源码：`deerflow/agents/middlewares/title_middleware.py`

用一个小 LLM 自动生成对话标题："CSV 分析脚本"。

### 21. MemoryMiddleware
源码：`deerflow/agents/middlewares/memory_middleware.py`

把对话放入去抖队列，30 秒后调用 LLM 提取事实存入 memory.json。

---

## 第 12 步：SSE 流式返回前端

Gateway 把结果通过 SSE 推送给前端：

```
event: metadata
data: {"thread_id":"abc","run_id":"run-123"}

event: messages
data: [[{"type":"human","content":"帮我写个 Python 脚本分析 CSV"}]]

event: messages
data: [[{"type":"ai","content":"好的，我来帮你写...","tool_calls":[...]}]]

event: messages
data: [[{"type":"tool","content":"id,name,score\n..."}]]

event: messages
data: [[{"type":"ai","content":"脚本写好了！要运行吗？"}]]

event: end
data: {}
```

前端收到事件，实时更新聊天界面。

---

## 关键设计总结

| 设计 | 解决什么问题 | 源码位置 |
|------|-------------|---------|
| LangGraph 图 | 检查点、暂停恢复、并行执行 | `langgraph.json` |
| make_lead_agent | 组装 Agent（模型+工具+中间件+提示） | `agents/lead_agent/agent.py` |
| 32 个中间件 | 在循环的关键点插入自定义逻辑 | `agents/middlewares/` |
| ThreadState + reducer | 并行修改同一字段时正确合并 | `agents/thread_state.py` |
| get_available_tools | 组装工具列表（配置+内置+MCP+社区） | `tools/tools.py` |
| 虚拟路径 | 安全隔离 + 路径一致性 | `sandbox/tools.py` |
| create_chat_model | 动态加载 LLM 提供商 | `models/factory.py` |
| ToolErrorHandling | 工具异常不崩溃，LLM 自己处理 | `agents/middlewares/tool_error_handling_middleware.py` |
| ReadBeforeWrite | 写文件前必须先读 | `agents/middlewares/read_before_write_middleware.py` |
| LoopDetection | 防止 LLM 陷入无限循环 | `agents/middlewares/loop_detection_middleware.py` |
| Clarification | LLM 想问用户时暂停执行 | `agents/middlewares/clarification_middleware.py` |

---

## 一次请求的完整调用链

```
前端 hooks.ts
  → POST /api/threads/{id}/runs/stream
  → Gateway threads.py
  → RunManager runtime/runs/worker.py
  → make_lead_agent() agents/lead_agent/agent.py
    → create_chat_model() models/factory.py
    → get_available_tools() tools/tools.py
    → build_middlewares() agents/lead_agent/agent.py
    → apply_prompt_template() agents/lead_agent/prompt.py
  → LangGraph 图执行
    → beforeModel: DynamicContext → SkillActivation → DurableContext → Summarization → ViewImage → SystemMessageCoalescing
    → LLM 调用
    → afterModel: LoopDetection → TokenBudget → TerminalResponse → Clarification
    → wrapToolCall: LLMErrorHandling → Guardrail → SandboxAudit → ReadBeforeWrite → ToolProgress → ToolErrorHandling
    → 实际工具: sandbox/tools.py → sandbox/local/
    → 结果返回 LLM
    → 循环直到完成
  → 后处理: Title → Memory
  → SSE 流式返回前端
```
