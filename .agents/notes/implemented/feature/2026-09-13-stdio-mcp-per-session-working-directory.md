# Agent Note: Stdio MCP servers spawned per session working directory

Status: implemented

English | [中文](2026-09-13-stdio-mcp-per-session-working-directory.zh.md)

## Problem

`@deepseek-ai/dsh-mcp-client` is mounted once per profile, so one stdio MCP server is one child process spawned in the DSH server process's working directory. An MCP server that derives its own project identity from its working directory — the `engram` memory server resolves a project from the git remote of its cwd, and repository or code-search servers do the same — therefore reports the harness checkout for every session, not the project of the session making the call. The harness composes plugins per session, but an MCP child is spawned once, so a shared child cannot know which project its caller belongs to. Nothing in the harness routes that context per call, and the child is long-lived enough that a launch-time cwd is the only directory it ever sees.

## Decision

`StdioConfig` gains an optional `cwdFromSession` boolean, default `false`; the Zod schema applies that default and `apply()` selects the pool only for `transport: 'stdio'` with the flag set. When it is set, the plugin starts the pool in [`packages/mcp/mcp-client/src/pool.ts`](../../../../packages/mcp/mcp-client/src/pool.ts) instead of one supervised connection.

The pool owns a publishing fallback connection plus one private connection per session working directory, created lazily on the first call from that directory. The fallback connection is a connection under config `cwd` and is the tool-surface authority: it runs discovery, registers the `mcp__<serverName>__<rawName>` tools, and handles `notifications/tools/list_changed`. Private connections pass `publish: false`, so they serve calls while sharing the same `serverName` and raw names without registering a second tool surface or running discovery, and they install no list-changed handler of their own.

[`ConnectionOptions`](../../../../packages/mcp/mcp-client/src/connection.ts) carries `publish` (default `true`) and `resolveClient`, and `ConnectionHandle.liveClient()` exposes the current generation's client or `undefined` while the connection is down. `ToolBridgeOptions.resolveClient` in [`packages/mcp/mcp-client/src/tools.ts`](../../../../packages/mcp/mcp-client/src/tools.ts) makes one published executor resolve its target client per call: the pool reads `exec.agent?.session.header.cwd` on each execution and falls back to config `cwd` when the execution carries no session or no session directory, awaits that connection's `ready`, and forwards the call to its live client. Disposal disposes every connection before awaiting any, so plugin teardown closes the fallback child and every private child and reaches quiescence.

The routing decision is per call rather than at load time because the plugin is mounted once per profile. The [agent-presets header comment](../../../../packages/preset/agent-presets/src/index.ts) states that convention — a preset is mounted once under a standing scope and its plugins key per session internally — and [`packages/sandbox/sandbox-policy/src/index.ts`](../../../../packages/sandbox/sandbox-policy/src/index.ts) is the precedent for resolving a session working directory per call instead of capturing it when the plugin loads.

## Alternatives considered

**Delete the `cwd` config.** The stdio child inherits the server process's working directory when no cwd is passed, so removing the field changes nothing for a session-derived identity. It only removes the operator's ability to place the child deliberately.

**Pin the project through config or environment.** Setting a project name or root on the plugin keeps one global child, so it trades the harness's directory for one fixed wrong project and cannot serve two sessions in different projects.

**Restart the single connection whenever the calling session's directory changes.** Concurrent sessions in different projects would thrash one child, and restarting during an in-flight call would lose its transport and fail a call that already started. Per-directory children keep each session's calls on a stable client.

**Switch `engram` to its HTTP server.** Changing how one server derives project identity is out of scope of the stdio MCP spawn plumbing and leaves every other directory-derived MCP server wrong.

## Consequences

One child per distinct directory lives for the plugin's lifetime. Ending a session does not reap its child, so a deployment whose sessions visit many directories keeps one child per directory until the plugin is disposed.

The model-visible tool surface always comes from the fallback connection, whose directory is config `cwd`. A private connection that advertises a different tool list serves those names once the model calls them, but it never changes the published set — including when that private connection re-syncs after a reconnect.

A private connection's connect or ready failure fails only the calls routed to it, with the same observable behavior as an outage in a single-connection deployment, and it consumes its own reconnect budget. A call whose directory has no live client fails with `mcp-client(<serverName>): no live connection for session working directory "<cwd>"`.

## Testing

`packages/mcp/mcp-client/tests/session-cwd.spec.ts` (mocked MCP SDK) covers routing to the child for the calling session's directory, reuse of one child per repeated directory, the fallback directory for a session in it and for a call without a session, exactly one discovery pass on the publishing connection, the no-live-child failure, and disposal closing every child.

`packages/mcp/mcp-client/tests/mcp-client.e2e.ts` ("spawns one child per session directory and reuses it") runs the real fixture child over stdio; the `where` tool added to [`tests/fixture-server.ts`](../../../../packages/mcp/mcp-client/tests/fixture-server.ts) reports `process.cwd()` and `process.pid`, proving that two session directories get different child processes in their own directories, that a repeated directory reuses its child's pid, and that a call without a session runs in the configured fallback. The package unit suite (112 tests) passes, `tsc -b tsconfig.host.json` passes, and per-file coverage of `packages/mcp/mcp-client/src` is 100%.

A manual out-of-tree check ran the real `engram` MCP server through the plugin from three working directories: each call reported its own project (`alpha-proj`, `beta-proj`, and `frappe`), while the configured fallback connection still reported the harness checkout.
