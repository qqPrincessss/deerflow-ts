---
name: deerflow-ts-dev
description: DeerFlow TypeScript 复刻项目开发准则。每次开发前必须读取。
---

# DeerFlow TypeScript 开发行为准则

## 核心原则

### 1. 禁止简化版

**最重要的规则：所有代码必须是完整版，不能是简化版。**

- 对照原项目 `C:\Users\Administrator\deer-flow\` 的源码
- 每个功能、每个字段、每个边界处理都要实现
- 不能因为"复杂"或"暂时不需要"就跳过
- 如果原项目有 100 行，我们也要写 100 行（TypeScript 等价）

### 2. 引导思考，不是写代码

**不要直接帮用户写代码。要引导用户思考。**

正确做法：
- 解释原项目的完整逻辑（读源码给用户看）
- 问用户"你觉得这个怎么实现"
- 用户写完后指出问题，让用户自己改
- 不要说"我帮你改"，说"你看看哪里有问题"

错误做法：
- 直接写出代码
- 说"我帮你加这个"
- 用户还没理解就往下写

### 3. 对照原项目

**每个文件都要对照原项目的对应文件。**

- 明确指出原项目文件路径
- 读原项目源码给用户看
- 解释每个函数、每个字段的作用
- 列出原项目有而我们没有的功能

### 4. 完整性检查

**每次提交前，检查是否完整。**

检查清单：
- [ ] 原项目有哪些字段/函数，我们都有吗？
- [ ] 原项目有哪些边界处理，我们都实现了吗？
- [ ] 原项目有哪些注释和文档，我们都写了？
- [ ] 类型定义完整吗？（interface、type、enum）
- [ ] 导出完整吗？（export）

### 5. 依赖顺序

**必须按依赖顺序开发。不能跳过依赖直接写上层模块。**

---

## 模块依赖图（开发顺序）

原项目根目录：`C:\Users\Administrator\deer-flow\backend\packages\harness\deerflow\`

### 第 0 层：无依赖（先写这些）

这些模块不依赖任何其他 deerflow 模块，可以最先写：

| 模块 | 原项目文件 | 作用 |
|------|-----------|------|
| constants | `constants.py` | 常量定义 |
| config/model_config | `config/model_config.py` | 模型配置 schema |
| config/memory_config | `config/memory_config.py` | 记忆配置 schema |
| config/sandbox_config | `config/sandbox_config.py` | 沙箱配置 schema |
| config/subagents_config | `config/subagents_config.py` | 子代理配置 schema |
| config/summarization_config | `config/summarization_config.py` | 压缩配置 schema |
| config/loop_detection_config | `config/loop_detection_config.py` | 循环检测配置 schema |
| config/token_budget_config | `config/token_budget_config.py` | Token 预算配置 schema |
| config/title_config | `config/title_config.py` | 标题配置 schema |
| config/tool_output_config | `config/tool_output_config.py` | 工具输出配置 schema |
| config/tool_progress_config | `config/tool_progress_config.py` | 工具进度配置 schema |
| config/read_before_write_config | `config/read_before_write_config.py` | 写前读配置 schema |
| config/safety_finish_reason_config | `config/safety_finish_reason_config.py` | 安全终止配置 schema |
| config/suggestions_config | `config/suggestions_config.py` | 建议配置 schema |
| config/skills_config | `config/skills_config.py` | 技能配置 schema |
| config/tool_search_config | `config/tool_search_config.py` | 工具搜索配置 schema |
| config/extensions_config | `config/extensions_config.py` | 扩展配置 schema |
| subagents/status_contract | `subagents/status_contract.py` | 子代理状态契约（无内部依赖） |
| agents/middlewares/tool_result_meta | `agents/middlewares/tool_result_meta.py` | 工具结果元数据（无内部依赖） |
| agents/middlewares/_bounded_dict | `agents/middlewares/_bounded_dict.py` | 有界字典（无内部依赖） |

### 第 1 层：基础类型和配置

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| agents/thread_state | constants, subagents/status_contract | `agents/thread_state.py` |
| config/app_config | 所有 config/* 模块 | `config/app_config.py` |
| config/paths | config/app_config | `config/paths.py` |
| agents/goal_state | 无 | `agents/goal_state.py` |
| agents/human_input | 无 | `agents/human_input.py` |

### 第 2 层：基础工具

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| agents/middlewares/skill_context | agents/thread_state | `agents/middlewares/skill_context.py` |
| agents/middlewares/delegation_ledger | agents/thread_state, subagents/status_contract | `agents/middlewares/delegation_ledger.py` |
| agents/middlewares/tool_call_metadata | agents/thread_state | `agents/middlewares/tool_call_metadata.py` |
| agents/middlewares/safety_termination_detectors | 无 | `agents/middlewares/safety_termination_detectors.py` |
| utils/messages | 无 | `utils/messages.py` |
| utils/llm_text | 无 | `utils/llm_text.py` |
| utils/time | 无 | `utils/time.py` |

### 第 3 层：运行时基础

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| runtime/user_context | config | `runtime/user_context.py` |
| runtime/secret_context | config | `runtime/secret_context.py` |
| runtime/context_keys | 无 | `runtime/context_keys.py` |
| runtime/serialization | 无 | `runtime/serialization.py` |
| runtime/converters | 无 | `runtime/converters.py` |
| reflection/resolvers | 无 | `reflection/resolvers.py` |

### 第 4 层：模型和记忆

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| models/factory | config, reflection | `models/factory.py` |
| models/vllm_provider | models/factory | `models/vllm_provider.py` |
| models/claude_provider | models/factory | `models/claude_provider.py` |
| agents/memory/storage | config | `agents/memory/storage.py` |
| agents/memory/prompt | config | `agents/memory/prompt.py` |
| agents/memory/updater | config, models, memory/storage, memory/prompt | `agents/memory/updater.py` |
| agents/memory/queue | config, memory/updater | `agents/memory/queue.py` |
| agents/memory/message_processing | 无 | `agents/memory/message_processing.py` |
| agents/memory/tools | memory/storage, memory/updater | `agents/memory/tools.py` |

### 第 5 层：沙箱系统

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| sandbox/sandbox | 无（抽象接口） | `sandbox/sandbox.py` |
| sandbox/sandbox_provider | config, sandbox/sandbox | `sandbox/sandbox_provider.py` |
| sandbox/security | config | `sandbox/security.py` |
| sandbox/env_policy | config | `sandbox/env_policy.py` |
| sandbox/exceptions | 无 | `sandbox/exceptions.py` |
| sandbox/file_operation_lock | 无 | `sandbox/file_operation_lock.py` |
| sandbox/path_patterns | 无 | `sandbox/path_patterns.py` |
| sandbox/search | 无 | `sandbox/search.py` |
| sandbox/local | sandbox/sandbox, sandbox/sandbox_provider | `sandbox/local/` |
| sandbox/tools | sandbox/sandbox, sandbox/sandbox_provider, config | `sandbox/tools.py` |
| sandbox/middleware | sandbox/sandbox_provider, config | `sandbox/middleware.py` |

### 第 6 层：工具系统

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| tools/types | 无 | `tools/types.py` |
| tools/mcp_metadata | 无 | `tools/mcp_metadata.py` |
| tools/sync | 无 | `tools/sync.py` |
| tools/builtins/clarification_tool | 无 | `tools/builtins/clarification_tool.py` |
| tools/builtins/present_file_tool | sandbox/tools | `tools/builtins/present_file_tool.py` |
| tools/builtins/view_image_tool | sandbox/tools | `tools/builtins/view_image_tool.py` |
| tools/builtins/task_tool | subagents/executor | `tools/builtins/task_tool.py` |
| tools/builtins/tool_search | mcp/tools | `tools/builtins/tool_search.py` |
| tools/builtins/setup_agent | config | `tools/builtins/setup_agent_tool.py` |
| tools/builtins/update_agent | config | `tools/builtins/update_agent_tool.py` |
| tools/tools | config, tools/builtins, mcp | `tools/tools.py` |

### 第 7 层：子代理系统

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| subagents/config | config | `subagents/config.py` |
| subagents/registry | config | `subagents/registry.py` |
| subagents/step_events | agents/thread_state | `subagents/step_events.py` |
| subagents/token_collector | 无 | `subagents/token_collector.py` |
| subagents/executor | agents, tools, subagents/*, models, config | `subagents/executor.py` |

### 第 8 层：中间件（按依赖顺序）

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| agents/middlewares/input_sanitization | agents/human_input, utils/messages | `input_sanitization_middleware.py` |
| agents/middlewares/tool_output_budget | config, sandbox/sandbox_provider | `tool_output_budget_middleware.py` |
| agents/middlewares/tool_result_sanitization | 无 | `tool_result_sanitization_middleware.py` |
| agents/middlewares/thread_data | agents/thread_state, config/paths, runtime/user_context | `thread_data_middleware.py` |
| agents/middlewares/uploads | config/paths, runtime/user_context, uploads/manager, utils | `uploads_middleware.py` |
| agents/middlewares/sandbox | sandbox/sandbox_provider, config | `sandbox/middleware.py` |
| agents/middlewares/dangling_tool_call | 无 | `dangling_tool_call_middleware.py` |
| agents/middlewares/llm_error_handling | config | `llm_error_handling_middleware.py` |
| agents/middlewares/guardrail | guardrails/provider | `guardrails/middleware.py` |
| agents/middlewares/sandbox_audit | agents/thread_state | `sandbox_audit_middleware.py` |
| agents/middlewares/read_before_write | tool_result_meta, sandbox/tools | `read_before_write_middleware.py` |
| agents/middlewares/tool_progress | tool_result_meta, _bounded_dict | `tool_progress_middleware.py` |
| agents/middlewares/tool_error_handling | skill_context, tool_result_meta, status_contract, config | `tool_error_handling_middleware.py` |
| agents/middlewares/dynamic_context | config, models, memory/* | `dynamic_context_middleware.py` |
| agents/middlewares/skill_activation | runtime/secret_context, skills/*, utils/messages | `skill_activation_middleware.py` |
| agents/middlewares/durable_context | delegation_ledger, skill_context, thread_state, config | `durable_context_middleware.py` |
| agents/middlewares/summarization | dynamic_context, config, models | `summarization_middleware.py` |
| agents/middlewares/todo | agents/thread_state | `todo_middleware.py` |
| agents/middlewares/token_usage | 无 | `token_usage_middleware.py` |
| agents/middlewares/title | dynamic_context, config, models | `title_middleware.py` |
| agents/middlewares/memory | memory/*, config, runtime, trace_context | `memory_middleware.py` |
| agents/middlewares/view_image | agents/thread_state | `view_image_middleware.py` |
| agents/middlewares/mcp_routing | config/tool_search, utils/messages | `mcp_routing_middleware.py` |
| agents/middlewares/deferred_tool_filter | 无 | `deferred_tool_filter_middleware.py` |
| agents/middlewares/system_message_coalescing | dynamic_context | `system_message_coalescing_middleware.py` |
| agents/middlewares/subagent_limit | tool_call_metadata, config/subagents, subagents/executor | `subagent_limit_middleware.py` |
| agents/middlewares/loop_detection | _bounded_dict | `loop_detection_middleware.py` |
| agents/middlewares/token_budget | _bounded_dict, config/token_budget | `token_budget_middleware.py` |
| agents/middlewares/safety_finish_reason | safety_termination_detectors, tool_call_metadata | `safety_finish_reason_middleware.py` |
| agents/middlewares/terminal_response | _bounded_dict | `terminal_response_middleware.py` |
| agents/middlewares/clarification | agents/human_input | `clarification_middleware.py` |

### 第 9 层：MCP 和技能

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| mcp/oauth | 无 | `mcp/oauth.py` |
| mcp/session_pool | 无 | `mcp/session_pool.py` |
| mcp/client | config | `mcp/client.py` |
| mcp/cache | config, mcp/client | `mcp/cache.py` |
| mcp/tools | mcp/cache | `mcp/tools.py` |
| skills/types | 无 | `skills/types.py` |
| skills/frontmatter | 无 | `skills/frontmatter.py` |
| skills/parser | skills/types | `skills/parser.py` |
| skills/permissions | config | `skills/permissions.py` |
| skills/storage | config, skills/types | `skills/storage.py` |
| skills/catalog | skills/types | `skills/catalog.py` |
| skills/describe | skills/catalog | `skills/describe.py` |
| skills/slash | skills/storage, skills/types | `skills/slash.py` |
| skills/tool_policy | skills/types | `skills/tool_policy.py` |
| skills/installer | config, skills/storage | `skills/installer.py` |
| skills/validation | 无 | `skills/validation.py` |
| skills/security_scanner | 无 | `skills/security_scanner.py` |
| skills/security_static_scanner | 无 | `skills/security_static_scanner.py` |

### 第 10 层：Agent 工厂

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| agents/lead_agent/prompt | config, skills/*, subagents, memory | `agents/lead_agent/prompt.py` |
| agents/lead_agent/agent | 所有中间件, tools, models, config | `agents/lead_agent/agent.py` |
| agents/factory | agents/lead_agent, config | `agents/factory.py` |

### 第 11 层：运行时

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| runtime/journal | config, runtime/* | `runtime/journal.py` |
| runtime/goal | config, models, runtime/user_context | `runtime/goal.py` |
| runtime/context_compaction | config | `runtime/context_compaction.py` |

### 第 12 层：应用层

| 模块 | 依赖 | 原项目文件 |
|------|------|-----------|
| client | 所有 harness 模块 | `client.py` |
| persistence/* | config | `persistence/` |
| tracing/* | config | `tracing/` |
| guardrails/* | config | `guardrails/` |
| scheduler/* | config | `scheduler/` |
| uploads/* | config | `uploads/` |
| workspace_changes/* | config | `workspace_changes/` |
| tui/* | 所有 harness 模块 | `tui/` |

---

## 开发流程

### 每次开发前

1. 读取本文件 `.agent/skills/deerflow-ts-dev/SKILL.md`
2. 确认当前要写的模块在依赖图中的位置
3. 检查它的依赖是否已经完成
4. 读取原项目对应的源码文件
5. 列出原项目的完整功能清单
6. 引导用户思考每个功能怎么实现

### 开发过程中

1. 用户写的代码，指出问题让用户自己改
2. 不要直接帮用户写
3. 每个功能都要确认用户理解了再继续
4. 发现简化版要立刻指出并补全

### 提交前

1. 对照原项目检查完整性
2. 运行 `npx tsc --noEmit` 确保零错误
3. 列出本次实现了原项目的哪些功能
4. 列出还缺什么功能

---

## 当前进度

已完成的模块：
- [x] config/model_config.ts
- [x] config/app_config.ts（部分）
- [x] models/factory.ts（简化版）
- [x] agents/thread_state.ts（完整版）
- [x] agents/middlewares/tool-error-handling.ts（需要重写）
- [x] agents/middlewares/loop-detection.ts（完整版）
- [x] agents/middlewares/dynamic-context.ts（需要重写）

下一步应该写的模块（按依赖顺序）：
1. constants.ts
2. subagents/status_contract.ts
3. agents/middlewares/tool_result_meta.ts
4. agents/middlewares/_bounded_dict.ts
5. agents/middlewares/skill_context.ts
6. agents/middlewares/delegation_ledger.ts
7. 然后重写 tool_error_handling.ts
8. 然后重写 dynamic_context.ts

---

## 原项目参考

原项目根目录：`C:\Users\Administrator\deer-flow\`

核心源码位置：
- Harness：`backend/packages/harness/deerflow/`
- 配置系统：`backend/packages/harness/deerflow/config/`
- Agent 系统：`backend/packages/harness/deerflow/agents/`
- 中间件：`backend/packages/harness/deerflow/agents/middlewares/`
- 沙箱：`backend/packages/harness/deerflow/sandbox/`
- 工具：`backend/packages/harness/deerflow/tools/`
- 子代理：`backend/packages/harness/deerflow/subagents/`
- 模型工厂：`backend/packages/harness/deerflow/models/`
- 运行时：`backend/packages/harness/deerflow/runtime/`
- 记忆：`backend/packages/harness/deerflow/agents/memory/`
- MCP：`backend/packages/harness/deerflow/mcp/`
- 技能：`backend/packages/harness/deerflow/skills/`

## 用户特点

- 用户想学习，不是想要代码
- 用户觉得简化版太简单，没有学到东西
- 用户需要理解每个设计决策的原因
- 用户需要知道原项目是怎么做的
