/**
 * Per-directory connection pool for one stdio MCP server: the fallback
 * connection discovers the published tool surface, while every call from a
 * session is served by a child process spawned in that session's working
 * directory. A server that derives its own project identity from the working
 * directory — a memory or repository server, for example — then sees the
 * calling session's project instead of the harness process's directory.
 *
 * One child per distinct directory, created on first use and shared by the
 * sessions in it, keeps a deployment that opens several projects from
 * restarting one child as its callers alternate. Each connection keeps its own
 * generation and reconnect budget; only the fallback connection publishes
 * tools, so private connections never contest the same public names.
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { startConnection } from './connection.ts'
import type { ConnectionHandle, ConnectionOutcome, ResolvedReconnectPolicy } from './connection.ts'
import type { StdioConfig } from './index.ts'

/** Handle for the stdio connections of one per-directory plugin instance. */
export interface PoolHandle {
  /** The publishing fallback connection's startup outcome; plugin activation awaits it. */
  ready: Promise<ConnectionOutcome>
  /**
   * Resolve the live client for one execution, opening a private connection for
   * its session working directory on first use.
   */
  resolveClient(exec: ToolExecution): Promise<Client>
  /** Dispose every connection, publishing and private, and await their quiescence. */
  dispose(): Promise<void>
}

/** The calling session's absolute working directory, when the execution carries a session that has one. */
function sessionCwdOf(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Start the publishing fallback connection plus one private connection per
 * session working directory, created on first use.
 * @param ctx - Cordis context providing the tool registry and logger.
 * @param config - Resolved stdio config; `cwd` is the fallback working directory.
 * @param policy - Resolved reconnect policy shared by every connection.
 * @returns the pool handle.
 */
export function startPool(ctx: Context, config: StdioConfig, policy: ResolvedReconnectPolicy): PoolHandle {
  const label = `mcp-client(${config.serverName})`
  const connections = new Map<string, ConnectionHandle>()

  /**
   * Resolve the child serving one execution. A directory's first call opens its
   * connection and awaits that attempt, so the call costs the same wait as
   * activation; a connection that is down instead fails the call, exactly as a
   * single-connection outage does.
   */
  async function resolveClient(exec: ToolExecution): Promise<Client> {
    const cwd = sessionCwdOf(exec) ?? config.cwd
    let handle = connections.get(cwd)
    if (handle === undefined) {
      handle = startConnection(ctx, { ...config, cwd }, policy, { publish: false })
      connections.set(cwd, handle)
    }
    await handle.ready
    const client = handle.liveClient()
    if (client === undefined) {
      throw new Error(`${label}: no live connection for session working directory ${JSON.stringify(cwd)}`)
    }
    return client
  }

  // Opened first so a fallback call never races a private connection onto the
  // same directory, and so the tool surface exists before the first turn.
  const fallback = startConnection(ctx, config, policy, { publish: true, resolveClient })
  connections.set(config.cwd, fallback)

  return {
    ready: fallback.ready,
    resolveClient,
    async dispose(): Promise<void> {
      // Every connection owns a child process and a reconnect timer: dispose
      // all of them before awaiting any, then await all, so teardown reaches
      // quiescence rather than only requesting it.
      await Promise.all([...connections.values()].map(handle => handle.dispose()))
    },
  }
}
