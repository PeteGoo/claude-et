import Docker from 'dockerode'

const docker = new Docker({ socketPath: '/var/run/docker.sock' })
const LOGIN_IMAGE = 'ghcr.io/petegoo/claude-et-session-base:latest'
const URL_REGEX = /https:\/\/[^\s]+/

/**
 * Manages the lifecycle of a `claude auth login` container session.
 * Uses docker exec with TTY to run `claude auth login` which provides
 * full OAuth scopes needed for remote-control. The CLI polls server-side
 * for authorization completion — no code paste required.
 */
export class LoginFlowSession {
  constructor({ log, image, cmd } = {}) {
    this.log = log || (() => {})
    this.image = image || LOGIN_IMAGE
    this.cmd = cmd || ['claude']
    this.container = null
    this.execStream = null
    this.output = ''
    this.authUrl = null
    this.startedAt = null
  }

  /**
   * Creates a container, then execs `claude auth login` with a TTY.
   * Polls the exec output for the auth URL.
   * @param {object} options
   * @param {number} options.deadlineMs - max time to wait for URL (default 60s)
   * @param {number} options.pollIntervalMs - poll interval (default 2s)
   * @returns {Promise<string>} the auth URL
   * @throws if URL not found within deadline
   */
  async start({ deadlineMs = 60000, pollIntervalMs = 2000 } = {}) {
    // Start a simple container that just sleeps
    this.container = await docker.createContainer({
      Image: this.image,
      Entrypoint: ['bash', '-c'],
      Cmd: [
        'mkdir -p /root/.claude && echo \'{"hasCompletedOnboarding":true}\' > /root/.claude/settings.json && sleep 300',
      ],
      Tty: true,
      HostConfig: { RestartPolicy: { Name: 'no' } },
    })

    await this.container.start()
    this.startedAt = Date.now()
    this.log(`container started: ${this.container.id}`)

    // Exec claude (interactive) — with onboarding done it goes straight to auth
    // Unlike `claude auth login` (which does server-side polling),
    // the interactive `claude` command accepts a code paste via stdin.
    const exec = await this.container.exec({
      Cmd: this.cmd,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    })

    this.execStream = await exec.start({ hijack: true, stdin: true, Tty: true })

    this.execStream.on('data', (chunk) => {
      this.output += chunk.toString('utf8')
    })

    // Poll for the auth URL in the exec output
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollIntervalMs))

      const inspect = await this.container.inspect()
      const status = inspect.State.Status
      this.log(`container status: ${status}`)
      if (status === 'exited' || status === 'dead') {
        throw new Error(`Container exited prematurely (exit code ${inspect.State.ExitCode})`)
      }

      const cleanOutput = this.output.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/[\x00-\x08]/g, '').trim()
      const match = cleanOutput.match(URL_REGEX)
      if (match) {
        this.authUrl = match[0]
        this.log(`auth URL found`)
        return this.authUrl
      }
    }

    throw new Error('Timed out waiting for auth URL from claude auth login')
  }

  /**
   * Writes the auth code into the exec stream's TTY stdin.
   * @param {string} code - the OAuth code from the browser
   */
  submitCode(code) {
    if (!this.execStream) throw new Error('No exec stream available')
    this.log(`submitting code (${code.length} chars), stream writable: ${this.execStream.writable}`)
    this.log(`output so far: ${this.output.slice(-200)}`)
    this.execStream.write(code + '\r')
    this.log('code written to exec stream')
  }

  /**
   * Checks whether `claude auth login` has completed by looking for
   * the credentials file in the container.
   * @returns {Promise<string|null>} the credentials JSON string, or null if not ready
   */
  async pollCredentials() {
    if (!this.container) return null
    this.log(`polling credentials, output tail: ${this.output.slice(-300)}`)

    try {
      const exec = await this.container.exec({
        Cmd: ['cat', '/root/.claude/.credentials.json'],
        AttachStdout: true,
        AttachStderr: true,
      })
      const stream = await exec.start({ Detach: false })
      const chunks = []
      await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk))
        stream.on('end', resolve)
        stream.on('error', reject)
      })
      const raw = Buffer.concat(chunks).toString('utf8')
      const clean = raw.replace(/[\x00-\x08]/g, '').trim()
      if (clean.includes('claudeAiOauth')) {
        const jsonStart = clean.indexOf('{')
        const jsonEnd = clean.lastIndexOf('}')
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const json = clean.slice(jsonStart, jsonEnd + 1)
          JSON.parse(json) // validate
          this.log('credentials file found')
          return json
        }
      }
    } catch {
      // File doesn't exist yet
    }
    return null
  }

  /**
   * Stops and removes the container, destroys the exec stream.
   */
  async cleanup() {
    if (this.execStream) {
      try { this.execStream.destroy() } catch {}
      this.execStream = null
    }
    if (this.container) {
      try { await this.container.stop({ t: 2 }) } catch {}
      try { await this.container.remove() } catch {}
      this.container = null
    }
  }
}
