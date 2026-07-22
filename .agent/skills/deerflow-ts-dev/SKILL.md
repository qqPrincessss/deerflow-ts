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

### 4. Harness Engineering 约束（腾讯 Harness 规范）

**基于 https://mp.weixin.qq.com/s/g4nTfxm7ebzRwkAVIGdIbg 和 https://mp.weixin.qq.com/s/LGo7daiYYRf1r_YY3r-cXw**

#### 4.1 清单驱动开发（能判定的就别留着）

**写代码前必须做：**
1. 读原项目的完整源码（全部读完，不能只看一部分）
2. 列出所有函数、类、字段的**完整清单**
3. 清单里的每一项都必须实现
4. 写完后凭清单逐项打勾
5. 不能自己判断"这个不重要"——必须让用户决定是否跳过
6. 每次回答以“亲爱的主人”为开头
7. 每次回答以“就是这样”结尾

**禁止行为：**
- ❌ 跳过原项目中的函数/字段，认为"TypeScript 不需要这个"
- ❌ 把多个函数合并成一个"简化版"
- ❌ 省略边界处理和错误处理
- ❌ 省略 Python 特有的功能（如 ContextVar、atexit）时不说一声

#### 4.2 完整性检查

**每次提交前，逐项检查：**
- [ ] 原项目的所有函数都实现了吗？
- [ ] 原项目的所有边界处理都实现了吗？
- [ ] 原项目的字段定义完全一致吗？
- [ ] 类型定义完整吗？（interface、type、enum）
- [ ] 导出完整吗？（export）
- [ ] 如果跳过/简化了什么功能，有明确的理由吗？

#### 4.3 依赖顺序

**必须按依赖顺序开发。不能跳过依赖直接写上层模块。**

---

## 项目信息

- 原项目根目录：`C:\Users\Administrator\deer-flow\`
- 原项目 harness：`C:\Users\Administrator\deer-flow\backend\packages\harness\deerflow\`
- 本项目根目录：`C:\Users\Administrator\Desktop\deer-flow-ts\`
- 本项目 harness：`C:\Users\Administrator\Desktop\deer-flow-ts\backend\packages\harness\src\`

---

## 开发计划（一个模块一个模块来）

### 第 0 层：无依赖（已完成 ✅）

| 序号 | 模块 | 状态 | 原项目文件 | 作用 |
|------|------|------|-----------|------|
| 0-1 | constants.ts | ✅ | `constants.py` | 常量定义 |
| 0-2 | config/model_config.ts | ✅ | `config/model_config.py` | 模型配置 schema |
| 0-3 | config/memory_config.ts | ✅ | `config/memory_config.py` | 记忆配置 schema |
| 0-4 | config/sandbox_config.ts | ✅ | `config/sandbox_config.py` | 沙箱配置 schema |
| 0-5 | config/subagents_config.ts | ✅ | `config/subagents_config.py` | 子代理配置 schema |
| 0-6 | config/summarization_config.ts | ✅ | `config/summarization_config.py` | 压缩配置 schema |
| 0-7 | config/loop_detection_config.ts | ✅ | `config/loop_detection_config.py` | 循环检测配置 schema |
| 0-8 | config/token_budget_config.ts | ✅ | `config/token_budget_config.py` | Token 预算配置 schema |
| 0-9 | config/title_config.ts | ✅ | `config/title_config.py` | 标题配置 schema |
| 0-10 | config/tool_output_config.ts | ✅ | `config/tool_output_config.py` | 工具输出配置 schema |
| 0-11 | config/tool_progress_config.ts | ✅ | `config/tool_progress_config.py` | 工具进度配置 schema |
| 0-12 | config/read_before_write_config.ts | ✅ | `config/read_before_write_config.py` | 写前读配置 schema |
| 0-13 | config/safety_finish_reason_config.ts | ✅ | `config/safety_finish_reason_config.py` | 安全终止配置 schema |
| 0-14 | config/suggestions_config.ts | ✅ | `config/suggestions_config.py` | 建议配置 schema |
| 0-15 | config/skills_config.ts | ✅ | `config/skills_config.py` | 技能配置 schema |
| 0-16 | config/tool_search_config.ts | ✅ | `config/tool_search_config.py` | 工具搜索配置 schema |
| 0-17 | config/extensions_config.ts | ✅ | `config/extensions_config.py` | 扩展配置 schema |
| 0-18 | subagents/status_contract.ts | ✅ | `subagents/status_contract.py` | 子代理状态契约 |
| 0-19 | agents/middlewares/tool_result_meta.ts | ✅ | `agents/middlewares/tool_result_meta.py` | 工具结果元数据 |
| 0-20 | agents/middlewares/_bounded_dict.ts | ✅ | `agents/middlewares/_bounded_dict.py` | 有界字典 |

---

### 第 1 层：基础类型和配置（5 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 1-1 | agents/goal_state.ts | ⬜ | 无 | `agents/goal_state.py` | 目标状态类型定义 |
| 1-2 | agents/human_input.ts | ⬜ | 无 | `agents/human_input.py` | 人机交互类型定义 |
| 1-3 | agents/thread_state.ts | ⬜ | constants, status_contract | `agents/thread_state.py` | Agent 状态定义（12 字段 + 8 reducer） |
| 1-4 | config/app_config.ts | ⬜ | 所有 config/* | `config/app_config.py` | 主配置（聚合所有子配置 + 加载 + 缓存） |
| 1-5 | config/paths.ts | ⬜ | config/app_config | `config/paths.py` | 路径解析工具 |

---

### 第 2 层：基础工具（7 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 2-1 | utils/messages.ts | ⬜ | 无 | `utils/messages.py` | 消息处理工具函数 |
| 2-2 | utils/llm_text.ts | ⬜ | 无 | `utils/llm_text.py` | LLM 文本处理（think 块剥离等） |
| 2-3 | utils/time.ts | ⬜ | 无 | `utils/time.py` | 时间工具函数 |
| 2-4 | agents/middlewares/skill_context.ts | ⬜ | thread_state | `skill_context.py` | 技能上下文捕获和渲染 |
| 2-5 | agents/middlewares/delegation_ledger.ts | ⬜ | thread_state, status_contract | `delegation_ledger.py` | 委托账本提取和渲染 |
| 2-6 | agents/middlewares/tool_call_metadata.ts | ⬜ | thread_state | `tool_call_metadata.py` | 工具调用元数据克隆 |
| 2-7 | agents/middlewares/safety_termination_detectors.ts | ⬜ | 无 | `safety_termination_detectors.py` | 安全终止检测器接口 |

---

### 第 3 层：运行时基础（6 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 3-1 | runtime/context_keys.ts | ⬜ | 无 | `runtime/context_keys.py` | 上下文 key 常量 |
| 3-2 | runtime/serialization.ts | ⬜ | 无 | `runtime/serialization.py` | 序列化工具 |
| 3-3 | runtime/converters.ts | ⬜ | 无 | `runtime/converters.py` | 类型转换工具 |
| 3-4 | reflection/resolvers.ts | ⬜ | 无 | `reflection/resolvers.py` | 动态模块加载（resolve_class） |
| 3-5 | runtime/user_context.ts | ⬜ | config | `runtime/user_context.py` | 用户上下文（get_effective_user_id） |
| 3-6 | runtime/secret_context.ts | ⬜ | config | `runtime/secret_context.py` | 密钥上下文（请求级密钥注入） |

---

### 第 4 层：模型和记忆（8 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 4-1 | models/factory.ts | ⬜ | config, reflection | `models/factory.py` | 模型工厂（create_chat_model） |
| 4-2 | models/vllm_provider.ts | ⬜ | models/factory | `models/vllm_provider.py` | vLLM 适配器 |
| 4-3 | models/claude_provider.ts | ⬜ | models/factory | `models/claude_provider.py` | Claude 适配器 |
| 4-4 | agents/memory/storage.ts | ⬜ | config | `agents/memory/storage.py` | 记忆存储（JSON 文件） |
| 4-5 | agents/memory/prompt.ts | ⬜ | config | `agents/memory/prompt.py` | 记忆提示模板 |
| 4-6 | agents/memory/updater.ts | ⬜ | config, models, storage, prompt | `agents/memory/updater.py` | 记忆更新器（LLM 事实提取） |
| 4-7 | agents/memory/queue.ts | ⬜ | config, updater | `agents/memory/queue.py` | 记忆队列（去抖） |
| 4-8 | agents/memory/message_processing.ts | ⬜ | 无 | `agents/memory/message_processing.py` | 消息过滤和处理 |

---

### 第 5 层：沙箱系统（11 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 5-1 | sandbox/exceptions.ts | ⬜ | 无 | `sandbox/exceptions.py` | 沙箱异常类型 |
| 5-2 | sandbox/sandbox.ts | ⬜ | 无 | `sandbox/sandbox.py` | 沙箱抽象接口 |
| 5-3 | sandbox/file_operation_lock.ts | ⬜ | 无 | `sandbox/file_operation_lock.py` | 文件操作锁 |
| 5-4 | sandbox/path_patterns.ts | ⬜ | 无 | `sandbox/path_patterns.py` | 路径模式匹配 |
| 5-5 | sandbox/search.ts | ⬜ | 无 | `sandbox/search.py` | 沙箱内搜索（grep） |
| 5-6 | sandbox/security.ts | ⬜ | config | `sandbox/security.py` | 安全检查（host bash 开关） |
| 5-7 | sandbox/env_policy.ts | ⬜ | config | `sandbox/env_policy.py` | 环境变量策略（密钥过滤） |
| 5-8 | sandbox/sandbox_provider.ts | ⬜ | config, sandbox | `sandbox/sandbox_provider.py` | 沙箱提供者接口 |
| 5-9 | sandbox/local/ | ⬜ | sandbox, provider | `sandbox/local/` | 本地沙箱实现 |
| 5-10 | sandbox/tools.ts | ⬜ | sandbox, provider, config | `sandbox/tools.py` | 沙箱工具（bash/ls/read/write） |
| 5-11 | sandbox/middleware.ts | ⬜ | provider, config | `sandbox/middleware.py` | 沙箱中间件 |

---

### 第 6 层：工具系统（11 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 6-1 | tools/types.ts | ⬜ | 无 | `tools/types.py` | 工具类型定义 |
| 6-2 | tools/mcp_metadata.ts | ⬜ | 无 | `tools/mcp_metadata.py` | MCP 元数据标记 |
| 6-3 | tools/sync.ts | ⬜ | 无 | `tools/sync.py` | 同步工具包装器 |
| 6-4 | tools/builtins/clarification_tool.ts | ⬜ | 无 | `clarification_tool.py` | 澄清工具（问用户） |
| 6-5 | tools/builtins/present_file_tool.ts | ⬜ | sandbox/tools | `present_file_tool.py` | 展示文件工具 |
| 6-6 | tools/builtins/view_image_tool.ts | ⬜ | sandbox/tools | `view_image_tool.py` | 查看图片工具 |
| 6-7 | tools/builtins/setup_agent.ts | ⬜ | config | `setup_agent_tool.py` | 创建自定义 Agent |
| 6-8 | tools/builtins/update_agent.ts | ⬜ | config | `update_agent_tool.py` | 更新自定义 Agent |
| 6-9 | tools/builtins/task_tool.ts | ⬜ | subagents/executor | `task_tool.py` | 任务委托工具 |
| 6-10 | tools/builtins/tool_search.ts | ⬜ | mcp/tools | `tool_search.py` | 工具搜索（延迟发现） |
| 6-11 | tools/tools.ts | ⬜ | config, builtins, mcp | `tools/tools.py` | 工具组装（get_available_tools） |

---

### 第 7 层：子代理系统（5 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 7-1 | subagents/config.ts | ⬜ | config | `subagents/config.py` | 子代理配置解析 |
| 7-2 | subagents/registry.ts | ⬜ | config | `subagents/registry.py` | 子代理注册表 |
| 7-3 | subagents/step_events.ts | ⬜ | thread_state | `subagents/step_events.py` | 步骤事件捕获 |
| 7-4 | subagents/token_collector.ts | ⬜ | 无 | `subagents/token_collector.py` | Token 用量收集器 |
| 7-5 | subagents/executor.ts | ⬜ | agents, tools, subagents/* | `subagents/executor.py` | 子代理执行器 |

---

### 第 8 层：中间件（27 个模块，按依赖顺序）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 8-1 | input_sanitization.ts | ⬜ | human_input, utils | `input_sanitization_middleware.py` | 输入净化（防注入） |
| 8-2 | tool_output_budget.ts | ⬜ | config, sandbox | `tool_output_budget_middleware.py` | 输出大小限制 |
| 8-3 | tool_result_sanitization.ts | ⬜ | 无 | `tool_result_sanitization_middleware.py` | 远程内容净化 |
| 8-4 | thread_data.ts | ⬜ | thread_state, paths, user_context | `thread_data_middleware.py` | 线程目录创建 |
| 8-5 | uploads.ts | ⬜ | paths, user_context, uploads | `uploads_middleware.py` | 上传文件处理 |
| 8-6 | sandbox_middleware.ts | ⬜ | sandbox_provider, config | `sandbox/middleware.py` | 沙箱生命周期 |
| 8-7 | dangling_tool_call.ts | ⬜ | 无 | `dangling_tool_call_middleware.py` | 悬空工具调用修补 |
| 8-8 | llm_error_handling.ts | ⬜ | config | `llm_error_handling_middleware.py` | LLM 错误标准化 |
| 8-9 | guardrail.ts | ⬜ | guardrails | `guardrails/middleware.py` | 工具调用授权 |
| 8-10 | sandbox_audit.ts | ⬜ | thread_state | `sandbox_audit_middleware.py` | 沙箱操作审计 |
| 8-11 | read_before_write.ts | ⬜ | tool_result_meta, sandbox | `read_before_write_middleware.py` | 写前读门控 |
| 8-12 | tool_progress.ts | ⬜ | tool_result_meta, bounded_dict | `tool_progress_middleware.py` | 停滞检测 |
| 8-13 | tool_error_handling.ts | ⬜ | skill_context, meta, contract | `tool_error_handling_middleware.py` | 工具异常处理 |
| 8-14 | dynamic_context.ts | ⬜ | config, models, memory | `dynamic_context_middleware.py` | 注入日期和记忆 |
| 8-15 | skill_activation.ts | ⬜ | secret_context, skills | `skill_activation_middleware.py` | /skill-name 激活 |
| 8-16 | durable_context.ts | ⬜ | ledger, skill_context, thread | `durable_context_middleware.py` | 持久上下文捕获 |
| 8-17 | summarization.ts | ⬜ | dynamic_context, config, models | `summarization_middleware.py` | 上下文压缩 |
| 8-18 | todo.ts | ⬜ | thread_state | `todo_middleware.py` | 待办事项追踪 |
| 8-19 | token_usage.ts | ⬜ | 无 | `token_usage_middleware.py` | Token 用量记录 |
| 8-20 | title.ts | ⬜ | dynamic_context, config, models | `title_middleware.py` | 标题自动生成 |
| 8-21 | memory_middleware.ts | ⬜ | memory/*, config, runtime | `memory_middleware.py` | 记忆更新队列 |
| 8-22 | view_image.ts | ⬜ | thread_state | `view_image_middleware.py` | 图片 base64 注入 |
| 8-23 | mcp_routing.ts | ⬜ | tool_search, utils | `mcp_routing_middleware.py` | MCP 工具自动提升 |
| 8-24 | deferred_tool_filter.ts | ⬜ | 无 | `deferred_tool_filter_middleware.py` | 延迟工具过滤 |
| 8-25 | system_message_coalescing.ts | ⬜ | dynamic_context | `system_message_coalescing_middleware.py` | 系统消息合并 |
| 8-26 | subagent_limit.ts | ⬜ | tool_call_metadata, config | `subagent_limit_middleware.py` | 子代理并发限制 |
| 8-27 | loop_detection.ts | ⬜ | bounded_dict | `loop_detection_middleware.py` | 循环检测 |
| 8-28 | token_budget.ts | ⬜ | bounded_dict, config | `token_budget_middleware.py` | Token 预算限制 |
| 8-29 | safety_finish_reason.ts | ⬜ | detectors, metadata | `safety_finish_reason_middleware.py` | 安全终止检测 |
| 8-30 | terminal_response.ts | ⬜ | bounded_dict | `terminal_response_middleware.py` | 空响应重试 |
| 8-31 | clarification.ts | ⬜ | human_input | `clarification_middleware.py` | 澄清请求拦截 |

---

### 第 9 层：MCP 和技能（18 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 9-1 | mcp/oauth.ts | ⬜ | 无 | `mcp/oauth.py` | OAuth 认证 |
| 9-2 | mcp/session_pool.ts | ⬜ | 无 | `mcp/session_pool.py` | 会话池管理 |
| 9-3 | mcp/client.ts | ⬜ | config | `mcp/client.py` | MCP 客户端 |
| 9-4 | mcp/cache.ts | ⬜ | config, client | `mcp/cache.py` | MCP 缓存 |
| 9-5 | mcp/tools.ts | ⬜ | cache | `mcp/tools.py` | MCP 工具加载 |
| 9-6 | skills/types.ts | ⬜ | 无 | `skills/types.py` | 技能类型定义 |
| 9-7 | skills/frontmatter.ts | ⬜ | 无 | `skills/frontmatter.py` | YAML frontmatter 解析 |
| 9-8 | skills/parser.ts | ⬜ | types | `skills/parser.py` | SKILL.md 解析 |
| 9-9 | skills/permissions.ts | ⬜ | config | `skills/permissions.py` | 技能权限 |
| 9-10 | skills/storage.ts | ⬜ | config, types | `skills/storage.py` | 技能存储 |
| 9-11 | skills/catalog.ts | ⬜ | types | `skills/catalog.py` | 技能目录 |
| 9-12 | skills/describe.ts | ⬜ | catalog | `skills/describe.py` | 技能描述 |
| 9-13 | skills/slash.ts | ⬜ | storage, types | `skills/slash.py` | /skill-name 解析 |
| 9-14 | skills/tool_policy.ts | ⬜ | types | `skills/tool_policy.py` | 工具权限策略 |
| 9-15 | skills/installer.ts | ⬜ | config, storage | `skills/installer.py` | 技能安装 |
| 9-16 | skills/validation.ts | ⬜ | 无 | `skills/validation.py` | 技能验证 |
| 9-17 | skills/security_scanner.ts | ⬜ | 无 | `skills/security_scanner.py` | 安全扫描 |
| 9-18 | skills/security_static_scanner.ts | ⬜ | 无 | `skills/security_static_scanner.py` | 静态安全扫描 |

---

### 第 10 层：Agent 工厂（3 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 10-1 | agents/lead_agent/prompt.ts | ⬜ | config, skills/*, subagents, memory | `agents/lead_agent/prompt.py` | 系统提示模板 |
| 10-2 | agents/lead_agent/agent.ts | ⬜ | 所有中间件, tools, models, config | `agents/lead_agent/agent.py` | Lead Agent 工厂 |
| 10-3 | agents/factory.ts | ⬜ | lead_agent, config | `agents/factory.py` | Agent 创建工厂 |

---

### 第 11 层：运行时（3 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 11-1 | runtime/journal.ts | ⬜ | config, runtime/* | `runtime/journal.py` | 运行日志 |
| 11-2 | runtime/goal.ts | ⬜ | config, models, user_context | `runtime/goal.py` | 目标评估 |
| 11-3 | runtime/context_compaction.ts | ⬜ | config | `runtime/context_compaction.py` | 上下文压缩 |

---

### 第 12 层：应用层（7+ 个模块）

| 序号 | 模块 | 状态 | 依赖 | 原项目文件 | 作用 |
|------|------|------|------|-----------|------|
| 12-1 | client.ts | ⬜ | 所有 harness | `client.py` | 嵌入式客户端 |
| 12-2 | persistence/* | ⬜ | config | `persistence/` | 持久化层 |
| 12-3 | tracing/* | ⬜ | config | `tracing/` | 链路追踪 |
| 12-4 | guardrails/* | ⬜ | config | `guardrails/` | 安全防护 |
| 12-5 | scheduler/* | ⬜ | config | `scheduler/` | 定时任务 |
| 12-6 | uploads/* | ⬜ | config | `uploads/` | 文件上传 |
| 12-7 | workspace_changes/* | ⬜ | config | `workspace_changes/` | 工作区变更 |

---

## 总计：约 115 个模块

### 开发顺序

1. 按层顺序：第 0 层 → 第 1 层 → ... → 第 12 层
2. 层内按序号顺序：1-1 → 1-2 → 1-3 → ...
3. 每个模块完成后标记 ✅，提交代码

### 每个模块的开发流程

1. **读准则**：读取本文件
2. **读原项目**：读取对应的原项目源码
3. **讲解**：解释模块的作用和设计决策
4. **列清单**：列出原项目的所有功能
5. **引导写代码**：引导用户思考并写代码
6. **检查完整性**：对照原项目检查
7. **编译验证**：运行 `npx tsc --noEmit`
8. **提交**：`git add -A && git commit && git push`

---

## 原项目参考

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
