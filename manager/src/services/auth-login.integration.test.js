import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Docker from 'dockerode'
import { pollContainerForAuthUrl } from './auth-login.js'

const docker = new Docker({ socketPath: '/var/run/docker.sock' })
const TEST_IMAGE = 'claude-et-session-base:test'

describe('pollContainerForAuthUrl integration', () => {
  it('extracts auth URL from real claude login output', async () => {
    let container

    try {
      container = await docker.createContainer({
        Image: TEST_IMAGE,
        Entrypoint: ['bash', '-c'],
        Cmd: ['claude auth login 2>&1'],
        Tty: true,
        HostConfig: {
          RestartPolicy: { Name: 'no' },
        },
      })

      await container.start()

      const result = await pollContainerForAuthUrl(container, {
        deadlineMs: 55000,
        pollIntervalMs: 2000,
        log: (msg) => console.log(`[integration-test] ${msg}`),
      })

      assert.ok(result, 'Expected pollContainerForAuthUrl to return a result (got null — URL not found in logs)')
      assert.ok(result.authUrl.startsWith('https://'), `Expected URL starting with https://, got: ${result.authUrl}`)
    } finally {
      if (container) {
        try { await container.stop({ t: 2 }) } catch {}
        try { await container.remove() } catch {}
      }
    }
  }, { timeout: 60000 })
})
