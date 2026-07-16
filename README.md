# DeerFlow TypeScript 复刻 — 学习笔记

> 基于原项目 `C:\Users\Administrator\deer-flow` 的真实代码，逐模块讲解每个设计。

---

## 目录

1. [项目是什么](#1-项目是什么)
2. [服务拓扑](#2-服务拓扑)
3. [核心执行循环](#3-核心执行循环)
4. [中间件链](#4-中间件链)
5. [ThreadState 状态系统](#5-threadstate-状态系统)
6. [虚拟路径系统](#6-虚拟路径系统)
7. [子代理系统](#7-子代理系统)
8. [记忆系统](#8-记忆系统)
9. [配置系统](#9-配置系统)
10. [Harness/App 分层](#10-harnessapp-分层)

---

## 1. 项目是什么

**一句话**：DeerFlow = AI + 手 + 脚 + 记忆。

ChatGPT 只能说话。DeerFlow 给 AI 一个完整的工作环境：
- 终端（bash 工具）→ 执行命令
- 文件系统（read/write）→ 读写文件
- 同事（子代理）→ 并行处理复杂任务
- 搜索引擎（MCP/社区工具）→ 查资料
- 记忆（memory.json）→ 记住用户偏好

**原项目入口**：`C:\Users\Administrator\deer-flow`

---

## 2. 服务拓扑

**原项目结构**（`C:\Users\Administrator\deer-flow`）：

```
deer-flow/
├── backend/                    # Python 后端
│   ├── packages/harness/       # 核心框架（deerflow.*）
│   │   └── deerflow/
│   │       ├── agents/         # Agent 系统
│   │       ├── sandbox/        # 沙箱系统
│   │       ├── subagents/      # 子代理系统
│   │       ├── tools/          # 工具系统
│   │       ├── mcp/            # MCP 集成
│   │       ├── models/         # 模型工厂
│   │       ├── skills/         # 技能系统
│   │       ├── config/         # 配置系统（40+ 配置类）
│   │       ├── memory/         # 记忆系统
│   │       └── runtime/        # 运行时管理
│   └── app/                    # 应用层（FastAPI Gateway）
│       ├── gateway/            # REST API + LangGraph 运行时
│       └── channels/           # IM 渠道（飞书/Slack/Telegram）
├── frontend/                   # Next.js 前端
├── config.example.yaml         # 配置模板
└── Makefile                    # 一键启动
```

**4 个服务**：
- **Nginx** (:2026) — 统一入口，反向代理
- **Gateway** (:8001) — FastAPI REST + LangGraph 运行时
- **Frontend** (:3000) — Next.js 聊天界面
- **Provisioner** (:8002) — K8s 沙箱（可选）

**关键设计**：Harness 是可发布框架包，App 依赖 Harness，Harness 永远不依赖 App。

**源码位置**：
- Harness 入口：`backend/packages/harness/deerflow/`
- App 入口：`backend/app/`
- 前端入口：`frontend/src/`

---

## 3. 核心执行循环

**这是整个系统的灵魂**。所有其他功能都是为了让这个循环更安全、更强大。

```
用户说话 → LLM 思考 → 要不要用工具？
                          ↓ 要
                      执行工具 → 把结果告诉 LLM → LLM 再思考 → 要不要用工具？
                                                                    ↓ 不要了
                                                                  回复用户
```

### 3.1 LLM 怎么"用工具"

LLM 不会真的执行代码。它只会输出一段结构化数据：

```json
{
  "tool_calls": [{
    "name": "read_file",
    "args": { "path": "config.yaml" }
  }]
}
```

你的代码拿到这个 tool_call，执行真正的文件读取，然后把结果塞回去。LLM 拿到结果后再决定下一步。

### 3.2 为什么用 LangGraph 而不是直接写循环

```python
# 天真的写法
while True:
    response = llm.invoke(messages)
    if not response.tool_calls:
        break
    for tool_call in response.tool_calls:
        result = execute_tool(tool_call)
        messages.append(result)
```

这个写法有 5 个问题：
1. **断了怎么办？** 程序崩了，对话历史全丢
2. **怎么暂停/恢复？** 用户关了浏览器，下次打开要能继续
3. **怎么并行执行工具？** LLM 一次调了 3 个工具，你串行执行太慢
4. **怎么做流式输出？** 用户想看到 LLM 一个字一个字蹦出来
5. **怎么做检查点？** 执行到第 5 步出了问题，想回到第 3 步重来

LangGraph 把循环变成一个"图"，检查点自动保存，解决了所有问题。

### 3.3 源码位置

- Agent 工厂：`backend/packages/harness/deerflow/agents/lead_agent/agent.py`
  - 入口函数：`make_lead_agent(config)`
  - 注册在 `backend/langgraph.json`
- 系统提示：`backend/packages/harness/deerflow/agents/lead_agent/prompt.py`
  - 函数：`apply_prompt_template()`

---

## 4. 中间件链

**中间件 = 拦截器**。在 Agent 执行的某些时刻插入自定义逻辑。

### 4.1 三个钩子点

每个中间件可以实现 3 个方法：
- `before_model` — LLM 调用前，可以改消息
- `after_model` — LLM 响应后，可以改响应
- `wrap_tool_call` — 包装工具执行，可以拦截、修改、替换

### 4.2 完整的 32 个中间件

**共享基础**（lead 和 subagent 都用）：
1. InputSanitization — 去掉恶意注入标签
2. ToolOutputBudget — 限制工具输出大小
3. ToolResultSanitization — 净化远程网页内容
4. ThreadData — 创建线程工作目录
5. Uploads — 处理上传的文件
6. Sandbox — 获取代码执行沙箱
7. DanglingToolCall — 修补中断的工具调用
8. LLMErrorHandling — 把 LLM 错误变成友好消息
9. Guardrail — 检查工具是否被允许（可选）
10. SandboxAudit — 记录沙箱操作日志
11. ReadBeforeWrite — 写文件前必须先读（可选）
12. ToolProgress — 检测工具是否陷入停滞（可选）
13. ToolErrorHandling — 工具异常变成错误消息

**Lead-only**（主代理专用）：
14. DynamicContext — 注入当前日期
15. SkillActivation — 处理 /skill-name 激活
16. DurableContext — 捕获委托和技能上下文
17. Summarization — 上下文太长时压缩（可选）
18. TodoList — 任务追踪（plan mode，可选）
19. TokenUsage — 记录 token 消耗（可选）
20. Title — 自动生成对话标题
21. Memory — 把对话存入长期记忆
22. ViewImage — 注入图片 base64（可选）
23. McpRouting — 自动提升 MCP 工具（可选）
24. DeferredToolFilter — 隐藏未激活的工具（可选）
25. SystemMessageCoalescing — 合并多个系统消息
26. SubagentLimit — 限制子代理数量（可选）
27. LoopDetection — 检测重复循环（可选）
28. TokenBudget — 限制 token 预算（可选）
29. Custom — 用户自定义中间件
30. TerminalResponse — 空响应重试
31. SafetyFinishReason — 安全终止检测（可选）
32. Clarification — 拦截"问用户"请求（必须最后）

### 4.3 最重要的 3 个中间件（面试必问）

**ToolErrorHandling**（第 13 个）：
```python
# 没有这个：bash 命令失败 → 异常 → Agent 崩溃
# 有了这个：bash 命令失败 → 捕获异常 → 包装成错误消息 → LLM 自己处理
def wrap_tool_call(self, request, handler):
    try:
        return handler(request)
    except Exception as exc:
        return ToolMessage(
            content=f"Error: {exc}",
            status="error"
        )
```

**LoopDetection**（第 27 个）：
LLM 有时会陷入循环：调工具 → 失败 → 再调同样的工具 → 无限循环。LoopDetection 记录最近 N 次调用，发现重复就强制停止。

**Clarification**（第 32 个）：
LLM 需要更多信息时调用 `ask_clarification` 工具。这个中间件拦截调用，暂停 Agent，把问题发给用户，等回答后再继续。

### 4.4 为什么中间件要按特定顺序？

因为后面的中间件依赖前面的：
- ThreadData 必须在 Sandbox 前面（沙箱需要知道线程目录）
- Uploads 必须在 ThreadData 后面（上传文件要放到线程目录）
- ToolErrorHandling 必须在 Clarification 前面（错误处理要在问用户之前）
- Clarification 必须最后（它是最终拦截点）

### 4.5 源码位置

- 共享基础中间件构建：`backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py`
  - 函数：`build_lead_runtime_middlewares()`
- Lead-only 中间件构建：`backend/packages/harness/deerflow/agents/lead_agent/agent.py`
  - 函数：`build_middlewares()`
- 单个中间件：`backend/packages/harness/deerflow/agents/middlewares/` 目录下每个文件一个

---

## 5. ThreadState 状态系统

**状态 = Agent 在节点之间传递的数据**。

### 5.1 完整状态定义

源码：`backend/packages/harness/deerflow/agents/thread_state.py`

```python
class ThreadState(AgentState):
    sandbox: SandboxState           # 沙箱状态
    thread_data: ThreadDataState    # 线程目录路径
    title: str                      # 对话标题
    artifacts: list[str]            # 产出文件列表
    todos: list                     # 待办事项
    goal: GoalState                 # 目标状态
    uploaded_files: list[dict]      # 上传文件
    viewed_images: dict             # 已查看图片
    promoted: PromotedTools         # 延迟工具提升
    delegations: list[DelegationEntry]  # 子代理委托账本
    skill_context: list[SkillEntry] # 激活的技能
    summary_text: str               # 压缩后的摘要
```

### 5.2 为什么需要 Reducer（合并函数）

LangGraph 是并行的。一个 Agent 可能同时调用 3 个工具，3 个工具都产出文件。如果直接覆盖，后写的会把先写的吃掉。

每个字段的 reducer 逻辑：

| 字段 | Reducer | 为什么 |
|------|---------|--------|
| messages | 直接替换 | LangGraph 内置 |
| sandbox | 幂等写入，冲突报错 | 一个线程只能有一个沙箱 |
| artifacts | **去重合并** | 多个工具可能产出同一个文件 |
| delegations | **按 ID 合并，终端状态不降级** | 子代理不能从 completed 回退到 running |
| skill_context | **按 path 去重，保留最近** | 同一个技能多次加载只保留最新 |
| summary_text | 后写覆盖 | 摘要是最后一次压缩的结果 |

### 5.3 `merge_delegations` 最复杂

```python
def merge_delegations(existing, new):
    # 1. 合并两个列表
    # 2. 按 ID 去重（同 ID 取最新的）
    # 3. 终端状态（completed/failed）不被非终端状态覆盖
    # 4. 限制最多 50 条记录
```

### 5.4 源码位置

- 状态定义：`backend/packages/harness/deerflow/agents/thread_state.py`

---

## 6. 虚拟路径系统

**Agent 看到的路径 ≠ 实际物理路径**。

### 6.1 路径映射

```
Agent 看到的：                    实际物理路径：
/mnt/user-data/workspace/   →   .deer-flow/users/{user_id}/threads/{thread_id}/user-data/workspace/
/mnt/user-data/uploads/     →   .deer-flow/users/{user_id}/threads/{thread_id}/user-data/uploads/
/mnt/user-data/outputs/     →   .deer-flow/users/{user_id}/threads/{thread_id}/user-data/outputs/
/mnt/skills/                →   deer-flow/skills/
```

### 6.2 为什么要翻译

1. **安全隔离**：用户 A 不能看到用户 B 的文件
2. **一致性**：不管本地运行还是 Docker 运行，Agent 写的代码都用同一个路径

### 6.3 沙箱工具

源码：`backend/packages/harness/deerflow/sandbox/tools.py`

| 工具 | 作用 |
|------|------|
| bash | 执行 shell 命令 |
| ls | 列出目录内容 |
| read_file | 读文件（支持行范围） |
| write_file | 写文件（支持追加） |
| str_replace | 替换文件中的字符串 |

### 6.4 源码位置

- 沙箱接口：`backend/packages/harness/deerflow/sandbox/sandbox.py`
- 本地沙箱：`backend/packages/harness/deerflow/sandbox/local/`
- 工具定义：`backend/packages/harness/deerflow/sandbox/tools.py`

---

## 7. 子代理系统

**复杂任务拆成小任务并行执行**。

### 7.1 工作流程

```
Lead Agent: "这个任务太复杂，派给别人"
  ↓ task("帮我搜索并分析", type="general-purpose")
SubagentExecutor:
  ├── 创建子代理（后台线程执行）
  ├── 每 5 秒检查进度
  ├── 推送 SSE 事件（task_started/task_running/task_completed）
  └── 结果返回给主代理
```

### 7.2 并发限制

- 每次响应最多 4 个子代理同时跑
- 整个运行周期最多 50 个
- 超过限制的 task 调用会被截掉

### 7.3 子代理不共享状态

子代理有自己的 ThreadState，执行完后只返回结果文本。主代理根据结果决定下一步。

### 7.4 防护机制

三个独立的"帽子"可以提前结束子代理：
- **Turn cap**：最大轮次（默认 150 轮）
- **Token cap**：最大 token 数
- **Loop cap**：检测到循环

### 7.5 源码位置

- 执行器：`backend/packages/harness/deerflow/subagents/executor.py`
- 内置子代理：`backend/packages/harness/deerflow/subagents/builtins/`
- 注册表：`backend/packages/harness/deerflow/subagents/registry.py`

---

## 8. 记忆系统

**从对话中提炼关键事实，跨对话保留**。

### 8.1 工作流程

```
对话："我喜欢用 TypeScript"
  ↓ MemoryMiddleware 捕获
  ↓ 等 30 秒（debounce）
  ↓ 调用 LLM 提取事实
  { content: "用户偏好 TypeScript", category: "preference", confidence: 0.9 }
  ↓ 写入 memory.json
  ↓ 下次对话时注入系统提示
  <memory>- 用户偏好 TypeScript (confidence: 0.9)</memory>
```

### 8.2 两种模式

- **middleware**（默认，被动）：自动从对话提取事实
- **tool**（实验性，主动）：LLM 自己决定什么时候记

### 8.3 数据结构

```json
{
  "workContext": "...",
  "personalContext": "...",
  "facts": [
    {
      "id": "abc-123",
      "content": "用户偏好 TypeScript",
      "category": "preference",
      "confidence": 0.9,
      "createdAt": "2026-07-15"
    }
  ]
}
```

### 8.4 过期和合并

- **Staleness review**：太旧的事实由 LLM 判断是否还有效
- **Consolidation**：碎片化事实合并成更精炼的表述

### 8.5 源码位置

- 记忆更新器：`backend/packages/harness/deerflow/agents/memory/updater.py`
- 存储：`backend/packages/harness/deerflow/agents/memory/storage.py`
- 提示模板：`backend/packages/harness/deerflow/agents/memory/prompt.py`
- 中间件：`backend/packages/harness/deerflow/agents/middlewares/memory_middleware.py`

---

## 9. 配置系统

**所有行为都从 config.yaml 读配置**。

### 9.1 配置文件

```
config.example.yaml  →  复制为 config.yaml（gitignored）
extensions_config.example.json  →  复制为 extensions_config.json（gitignored）
.env.example  →  复制为 .env（gitignored）
```

### 9.2 配置类（40+ 个）

源码：`backend/packages/harness/deerflow/config/`

```
app_config.py          # 主配置（聚合所有子配置）
model_config.py        # 模型配置
memory_config.py       # 记忆配置
sandbox_config.py      # 沙箱配置
subagents_config.py    # 子代理配置
summarization_config.py # 压缩配置
title_config.py        # 标题配置
token_budget_config.py # Token 预算配置
loop_detection_config.py # 循环检测配置
...
```

### 9.3 环境变量解析

配置值以 `$` 开头的会自动解析为环境变量：
```yaml
api_key: $OPENAI_API_KEY  # 自动从 .env 读取
```

### 9.4 热重载

运行时修改 config.yaml，大部分配置立刻生效（模型、记忆、子代理等）。基础设施配置（数据库、沙箱模式）需要重启。

### 9.5 源码位置

- 主配置：`backend/packages/harness/deerflow/config/app_config.py`
  - 函数：`get_app_config()`

---

## 10. Harness/App 分层

### 10.1 依赖规则

```
App (app.*)  →  可以 import →  Harness (deerflow.*)
Harness      →  永远不能 import →  App
```

这个规则由测试强制执行：`backend/tests/test_harness_boundary.py`

### 10.2 为什么要分层

- **Harness** 是可发布的 npm/pip 包，任何人可以用它构建自己的 Agent 系统
- **App** 是 DeerFlow 的具体实现（Gateway + IM 渠道）
- 分层让 Harness 可以被其他项目复用

### 10.3 源码位置

- Harness：`backend/packages/harness/deerflow/`
- App：`backend/app/`
- 边界测试：`backend/tests/test_harness_boundary.py`

---

## 面试速记卡

| 问题 | 答案 |
|------|------|
| DeerFlow 是什么 | LangGraph-based AI super-agent harness，给 LLM 一个完整工作环境 |
| 核心执行循环 | 用户消息 → LLM → 工具调用 → 结果 → LLM → 最终回复 |
| 为什么用 LangGraph | 检查点、暂停恢复、并行执行、流式输出 |
| 中间件是什么 | 拦截器，在 Agent 循环的关键点插入自定义逻辑 |
| 最重要的 3 个中间件 | ToolErrorHandling（容错）、LoopDetection（防循环）、Clarification（问用户） |
| 虚拟路径 | Agent 看 /mnt/user-data/...，实际是线程隔离的物理路径 |
| 子代理 | 并行执行子任务，只和主代理通信，不共享状态 |
| 记忆 | 从对话提炼事实，存文件，下次注入系统提示 |
| Harness/App 分层 | Harness 是可发布框架，App 是应用层，Harness 不依赖 App |
| Reducer 是什么 | 状态合并函数，处理并行修改同一字段的情况 |
| 40+ 配置类 | 每个子系统一个配置类，Zod/Pydantic 校验，支持热重载 |
