import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

// ─── URL extraction tests ───────────────────────────────────────────────────

describe('LoginFlowSession URL extraction', () => {
  it('extracts auth URL from claude auth login output', async () => {
    const stream = new PassThrough()
    const authUrl = 'https://claude.ai/oauth/authorize?code=true&client_id=test&scope=user%3Asessions%3Aclaude_code&state=abc'

    setTimeout(() => {
      stream.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${authUrl}\n`)
    }, 50)

    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })

    await new Promise(r => setTimeout(r, 200))

    const match = output.match(/https:\/\/[^\s]+/)
    assert.ok(match, 'URL should be found in output')
    assert.equal(match[0], authUrl)
  })

  it('returns no URL when container exits prematurely', async () => {
    const stream = new PassThrough()

    setTimeout(() => {
      stream.write('some error output')
    }, 50)

    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })

    await new Promise(r => setTimeout(r, 200))

    const match = output.match(/https:\/\/[^\s]+/)
    assert.equal(match, null, 'No URL should be found')
  })
})

// ─── Credentials extraction tests ───────────────────────────────────────────

describe('LoginFlowSession credentials polling', () => {
  it('validates credentials JSON contains claudeAiOauth', () => {
    const creds = JSON.stringify({
      claudeAiOauth: {
        token: 'sk-ant-oat01-abc123',
        subscriptionType: 'pro',
        expiresAt: '2027-01-01T00:00:00Z',
        refreshToken: 'refresh-123',
      },
    })

    const parsed = JSON.parse(creds)
    assert.ok(parsed.claudeAiOauth, 'Should have claudeAiOauth key')
    assert.ok(parsed.claudeAiOauth.token, 'Should have token')
    assert.equal(parsed.claudeAiOauth.subscriptionType, 'pro')
  })

  it('rejects JSON without claudeAiOauth key', () => {
    const raw = '{"someOther": "data"}'
    const clean = raw.replace(/[\x00-\x08]/g, '').trim()
    assert.ok(!clean.includes('claudeAiOauth'), 'Should not contain claudeAiOauth')
  })

  it('extracts JSON from Docker stream output with header bytes', () => {
    const creds = { claudeAiOauth: { token: 'test', subscriptionType: 'pro' } }
    const raw = `\x01\x00\x00\x00\x00\x00\x00\x42${JSON.stringify(creds)}`
    const clean = raw.replace(/[\x00-\x08]/g, '').trim()
    assert.ok(clean.includes('claudeAiOauth'))
    const jsonStart = clean.indexOf('{')
    const jsonEnd = clean.lastIndexOf('}')
    const json = clean.slice(jsonStart, jsonEnd + 1)
    const parsed = JSON.parse(json)
    assert.equal(parsed.claudeAiOauth.subscriptionType, 'pro')
  })
})
