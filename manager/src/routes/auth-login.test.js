import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { pollContainerForAuthUrl } from '../services/auth-login.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockContainer({ logs, inspectState }) {
  return {
    id: 'test-container-123',
    inspect: mock.fn(async () => ({
      State: inspectState ?? { Status: 'running', ExitCode: 0 },
    })),
    logs: mock.fn(async () => Buffer.from(logs ?? '')),
  }
}

const fastOpts = { deadlineMs: 3000, pollIntervalMs: 50 }

// ─── Unit Tests ─────────────────────────────────────────────────────────────

describe('pollContainerForAuthUrl', () => {
  it('returns authUrl when URL is found in logs', async () => {
    const authUrl = 'https://console.anthropic.com/oauth/authorize?client_id=test&scope=user:inference&redirect_uri=http%3A%2F%2Flocalhost'
    const container = createMockContainer({
      logs: `To sign in to your Anthropic account, please visit:\n${authUrl}\nWaiting for authentication...`,
    })

    const result = await pollContainerForAuthUrl(container, fastOpts)

    assert.ok(result)
    assert.equal(result.authUrl, authUrl)
  })

  it('returns null when no URL is found (entrypoint bug)', async () => {
    const container = createMockContainer({
      logs: [
        "WARNING: No Claude credentials found at /root/.claude/.credentials.json",
        "Contents of /root/.claude/:",
        "Session 'claude-main' started in /repos",
        "Claude command: claude remote-control --spawn=same-dir",
        "Connect with: tmux attach -t claude-main",
      ].join('\n'),
    })

    const result = await pollContainerForAuthUrl(container, fastOpts)

    assert.equal(result, null)
  })

  it('returns null when container exits prematurely', async () => {
    const container = createMockContainer({
      logs: 'some error output',
      inspectState: { Status: 'exited', ExitCode: 1 },
    })

    const result = await pollContainerForAuthUrl(container, fastOpts)

    assert.equal(result, null)
  })

  it('extracts URL even with Docker stream header bytes present', async () => {
    const authUrl = 'https://console.anthropic.com/oauth/authorize?session=abc123'
    const container = createMockContainer({
      logs: `\x01\x00\x00\x00\x00\x00\x00\x42To sign in, visit:\n${authUrl}`,
    })

    const result = await pollContainerForAuthUrl(container, fastOpts)

    assert.ok(result)
    assert.equal(result.authUrl, authUrl)
  })
})
