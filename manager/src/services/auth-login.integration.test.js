import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LoginFlowSession } from './auth-login.js'

describe('LoginFlowSession integration', () => {
  it('extracts auth URL from real claude setup-token output', async () => {
    const session = new LoginFlowSession({
      log: (msg) => console.log(`[integration-test] ${msg}`),
    })

    try {
      const authUrl = await session.start({
        deadlineMs: 55000,
        pollIntervalMs: 2000,
      })

      assert.ok(authUrl, 'Expected start() to return an auth URL')
      assert.ok(authUrl.startsWith('https://'), `Expected URL starting with https://, got: ${authUrl}`)
      assert.ok(authUrl.includes('claude.ai/oauth'), `Expected claude.ai OAuth URL, got: ${authUrl}`)
    } finally {
      await session.cleanup()
    }
  }, { timeout: 60000 })
})
