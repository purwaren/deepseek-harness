/**
 * Tests for per-session working-directory stdio connections
 * (`cwdFromSession`): the published tool surface comes from the fallback
 * connection, each distinct session directory gets its own child created on
 * first use, calls route to the child for the calling session's directory, and
 * disposal closes every child.
 *
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock classes
// and state must be created inside vi.hoisted to exist when the factories run.
const mockState = vi.hoisted(() => {
  /** Directories whose child refuses to connect, so the pool has no live client. */
  const failingCwds = new Set<string>()
  const listTools = vi.fn(async () => ({
    tools: [
      {
        name: 'where',
        description: 'Report the working directory of the child that serves the call',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))

  /** stdio transport stand-in: keeps the config the bridge spawned it with. */
  class MockStdioClientTransport {
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      this.options = options
    }
  }

  class MockClient {
    static instances: MockClient[] = []
    transport: object | undefined = {}
    /** Working directory of the transport this client connected over. */
    transportCwd = ''
    closed = false
    onclose: (() => void) | undefined
    constructor(_info: unknown, _options: { listChanged: { tools: { onChanged: () => void } } }) {
      MockClient.instances.push(this)
    }
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    listResources = async () => ({ resources: [] })
    async connect(transport: { options?: Record<string, unknown> }): Promise<void> {
      const declared = transport.options?.cwd
      const cwd = typeof declared === 'string' ? declared : ''
      if (failingCwds.has(cwd)) throw new Error(`connect refused for ${cwd}`)
      this.transportCwd = cwd
    }
    async close(): Promise<void> {
      this.closed = true
      // The real transport fires its close signal on shutdown; the supervisor
      // waits for that signal to prove a generation is gone.
      this.onclose?.()
    }
    listTools = listTools
    // Answering with the serving child's directory is what makes routing
    // observable from the tool result alone.
    async callTool(): Promise<unknown> {
      return { content: [{ type: 'text', text: `where@${this.transportCwd}` }] }
    }
  }

  return { failingCwds, listTools, MockClient, MockStdioClientTransport }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: mockState.MockClient,
  StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: mockState.MockStdioClientTransport,
}))

// vi.mock is hoisted above static imports, so the module under test sees the
// mocked SDK even through a static import.
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'

// ---- Helpers ----

const testToolSignal = new AbortController().signal

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const stdioConfig: Config = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'echo',
  args: [],
  env: {},
  cwd: '/fallback',
  cwdFromSession: true,
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

/** Calling-agent stand-in whose session carries one absolute working directory. */
function agentIn(cwd: string): object {
  return { options: {}, session: { header: { cwd }, requestHeader: () => undefined } }
}

/** Execute the bridged tool, optionally on behalf of a session in one directory. */
async function executeWhere(ctx: Context, agent?: object) {
  return await ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('c1'),
    name: 'mcp__srv__where',
    arguments: {},
    ...agent === undefined ? {} : { agent: agent as never },
  })
}

// ---- Tests ----

describe('cwdFromSession stdio pool', () => {
  let ctx: Context

  beforeEach(async () => {
    mockState.MockClient.instances.length = 0
    mockState.failingCwds.clear()
    mockState.listTools.mockClear()
    ctx = await mountRegistry()
  })

  it('publishes the fallback surface once and serves each session directory from its own child', async () => {
    await apply(ctx, stdioConfig)
    const instances = mockState.MockClient.instances

    expect(instances).toHaveLength(1)
    expect(instances[0]?.transportCwd).toBe('/fallback')
    expect(ctx.tools.get('mcp__srv__where')).toBeDefined()
    // Only the publishing connection discovers tools.
    expect(mockState.listTools).toHaveBeenCalledTimes(1)

    expect((await executeWhere(ctx, agentIn('/project-a'))).content)
      .toEqual([{ type: 'text', text: 'where@/project-a' }])
    expect(instances).toHaveLength(2)

    // A second call in the same directory reuses that child.
    expect((await executeWhere(ctx, agentIn('/project-a'))).content)
      .toEqual([{ type: 'text', text: 'where@/project-a' }])
    expect(instances).toHaveLength(2)

    // A different directory gets its own child.
    expect((await executeWhere(ctx, agentIn('/project-b'))).content)
      .toEqual([{ type: 'text', text: 'where@/project-b' }])
    expect(instances).toHaveLength(3)

    // A session in the fallback directory reuses the publishing connection.
    expect((await executeWhere(ctx, agentIn('/fallback'))).content)
      .toEqual([{ type: 'text', text: 'where@/fallback' }])
    expect(instances).toHaveLength(3)

    // A call without a session uses the fallback directory, never the harness
    // process directory.
    expect((await executeWhere(ctx)).content).toEqual([{ type: 'text', text: 'where@/fallback' }])
    expect(instances).toHaveLength(3)
  })

  it('fails a call whose session directory has no live child', async () => {
    mockState.failingCwds.add('/broken')
    await apply(ctx, { ...stdioConfig, reconnect: { enabled: false } })

    const result = await executeWhere(ctx, agentIn('/broken'))

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Error: mcp-client(srv): no live connection for session working directory "/broken"',
      },
    ])
  })

  it('closes every child on disposal', async () => {
    await apply(ctx, stdioConfig)
    await executeWhere(ctx, agentIn('/project-a'))
    await executeWhere(ctx, agentIn('/project-b'))
    const instances = mockState.MockClient.instances
    expect(instances).toHaveLength(3)

    await ctx.fiber.dispose()

    expect(instances.map(instance => instance.closed)).toEqual([true, true, true])
  })
})
