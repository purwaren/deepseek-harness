# Agent Note: 按会话工作目录 spawn 的 stdio MCP 服务器

Status: implemented

[English](2026-09-13-stdio-mcp-per-session-working-directory.md) | 中文

## Problem

`@deepseek-ai/dsh-mcp-client` 对每个 profile 只挂载一次，因此一个 stdio MCP 服务器就是一个子进程，spawn 在 DSH 服务器进程的工作目录中。若 MCP 服务器从自身工作目录推导项目身份——`engram` 记忆服务器依据其 cwd 的 git remote 解析项目，仓库类或代码搜索类服务器同样如此——它对每个会话都报告 harness 检出目录，而不是发起调用的会话所在的项目。harness 按会话组合插件，但 MCP 子进程只 spawn 一次，共享的子进程无从知道其调用方属于哪个项目。harness 中没有任何机制按调用路由这一上下文，而子进程的生命周期又足够长，启动时的 cwd 是它唯一见到的目录。

## Decision

`StdioConfig` 新增可选布尔字段 `cwdFromSession`，默认 `false`；Zod schema 施加该默认值，`apply()` 仅在 `transport: 'stdio'` 且该标志为真时选择连接池。启用时，插件不再启动单个受监管连接，而是启动 [`packages/mcp/mcp-client/src/pool.ts`](../../../../packages/mcp/mcp-client/src/pool.ts) 中的连接池。

连接池持有一个发布用的 fallback 连接，外加每个会话工作目录一个私有连接，私有连接在来自该目录的首次调用时惰性创建。fallback 连接是以配置 `cwd` 建立的连接，也是工具门面的权威：它执行发现、注册 `mcp__<serverName>__<rawName>` 工具，并在 client 的列表变更订阅触发时重新同步。私有连接传入 `publish: false`，因此它们服务于调用，共用同一个 `serverName` 与原始名称，却不注册第二份工具门面、不执行发现，也不在列表变更时重新同步。`PoolHandle` 同时实现 `ServerContext`，将 `resources` 与 `instructions()` 委托给 fallback 连接，因此无论连接池打开了多少私有连接，`registerServerContext` 每个插件实例只发布一份资源提供方与一段归属说明文本。

[`ConnectionOptions`](../../../../packages/mcp/mcp-client/src/connection.ts) 承载 `publish`（默认 `true`）与 `resolveClient`，`ConnectionHandle.liveClient()` 暴露当前代的 client，连接不可用时返回 `undefined`。[`packages/mcp/mcp-client/src/tools.ts`](../../../../packages/mcp/mcp-client/src/tools.ts) 中的 `ToolBridgeOptions.resolveClient` 让一个已发布的执行器按调用解析目标 client：连接池在每次执行时读取 `exec.agent?.session.header.cwd`，当该执行不带会话或不带会话目录时回退到配置 `cwd`，等待该连接的 `ready`，再把调用转发给它的活动 client。dispose 会先 dispose 全部连接再统一等待，因此插件拆卸会关闭 fallback 子进程与每一个私有子进程，并达到完全停稳。

路由在每次调用时决定，而不是在加载时决定，因为插件对每个 profile 只挂载一次。[agent-presets 头部注释](../../../../packages/preset/agent-presets/src/index.ts) 陈述了该惯例——preset 在常驻作用域下只挂载一次，其插件在内部按会话为键——而 [`packages/sandbox/sandbox-policy/src/index.ts`](../../../../packages/sandbox/sandbox-policy/src/index.ts) 是按调用而非加载时解析会话工作目录的先例。

## Alternatives considered

**删除 `cwd` 配置。** 不传 cwd 时 stdio 子进程本就继承服务器进程的工作目录，所以删除该字段对会话推导的身份毫无改变，只是去掉了运维人员有意安置子进程的能力。

**通过配置或环境变量钉住项目。** 在插件上设置项目名或项目根仍只保留一个全局子进程，等于把 harness 的目录换成另一个固定的错误项目，无法服务位于不同项目的两个会话。

**在调用会话的目录变化时重启单一连接。** 位于不同项目的并发会话会让同一个子进程来回抖动，而在调用进行中重启会丢失该调用的传输并使其失败。按目录区分的子进程让每个会话的调用始终落在稳定的 client 上。

**把 `engram` 切换为它的 HTTP 服务器。** 改变某一个服务器推导项目身份的方式超出 stdio MCP spawn 管线的范围，而且其他所有依据目录推导身份的 MCP 服务器仍然错误。

## Consequences

每个不同目录的子进程都会存活到插件生命周期结束。结束会话不会回收其子进程，因此会话访问过许多目录的部署会一直保留每目录一个子进程，直到插件被 dispose。

模型可见的工具门面始终来自 fallback 连接，其目录为配置 `cwd`。私有连接若声明了不同的工具列表，这些名称在模型调用时会被服务，但它不会改变已发布集合——私有连接在重连后重新同步时也是如此。

私有连接的连接或 ready 失败只使路由到它的调用失败，其可观察行为与单连接部署中的一次中断相同，并消耗它自己的重连预算。目录没有活动 client 的调用会以 `mcp-client(<serverName>): no live connection for session working directory "<cwd>"` 失败。

## Testing

`packages/mcp/mcp-client/tests/session-cwd.spec.ts`（mock 掉 MCP SDK）覆盖：路由到调用会话目录对应的子进程、对重复目录复用同一个子进程、位于 fallback 目录的会话以及不带会话的调用使用 fallback 目录、发布连接上恰好执行一次发现、无活动子进程时的失败，以及 dispose 关闭每一个子进程。

`packages/mcp/mcp-client/tests/mcp-client.e2e.ts`（"spawns one child per session directory and reuses it"）通过 stdio 运行真实的 fixture 子进程；[`tests/fixture-server.ts`](../../../../packages/mcp/mcp-client/tests/fixture-server.ts) 中新增的 `where` 工具报告 `process.cwd()` 与 `process.pid`，证明两个会话目录得到各自目录中的不同子进程、重复目录复用同一子进程的 pid，以及不带会话的调用运行在配置的 fallback 中。包单元测试套件（128 个测试）通过，`tsc -b tsconfig.host.json` 通过，`packages/mcp/mcp-client/src` 的逐文件覆盖率为 100%。

一次仓库外的人工检查从三个工作目录通过该插件运行了真实的 `engram` MCP 服务器：每次调用都报告了各自的项目（`alpha-proj`、`beta-proj` 与 `frappe`），而配置的 fallback 连接仍报告 harness 检出目录。
