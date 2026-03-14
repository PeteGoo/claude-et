import Docker from 'dockerode'

const docker = new Docker({ socketPath: '/var/run/docker.sock' })
const LOGIN_IMAGE = 'ghcr.io/petegoo/claude-et-session-base:latest'
const URL_REGEX = /https:\/\/[^\s]+/
const TOKEN_REGEX = /sk-ant-oat01-[A-Za-z0-9_-]+/

/**
 * Manages the lifecycle of a `claude setup-token` container session.
 * Handles container creation, stdin/stdout streaming, URL extraction,
 * and code submission.
 */
export class LoginFlowSession {
  constructor({ log, image } = {}) {
    this.log = log || (() => {})
    this.image = image || LOGIN_IMAGE
    this.container = null
    this.stream = null
    this.output = ''
    this.authUrl = null
    this.startedAt = null
  }

  /**
   * Creates the container, attaches stdin/stdout, starts it, and
   * polls the output buffer for the auth URL.
   * @param {object} options
   * @param {number} options.deadlineMs - max time to wait for URL (default 60s)
   * @param {number} options.pollIntervalMs - poll interval (default 2s)
   * @returns {Promise<string>} the auth URL
   * @throws if URL not found within deadline
   */
  async start({ deadlineMs = 60000, pollIntervalMs = 2000 } = {}) {
    this.container = await docker.createContainer({
      Image: this.image,
      Entrypoint: ['bash', '-c'],
      Cmd: [
        'mkdir -p /root/.claude && echo \'{"hasCompletedOnboarding":true}\' > /root/.claude/settings.json && claude setup-token 2>&1; sleep 30',
      ],
      Tty: true,
      OpenStdin: true,
      HostConfig: { RestartPolicy: { Name: 'no' } },
    })

    // Attach before starting to capture all output
    this.stream = await this.container.attach({
      stream: true, stdin: true, stdout: true, stderr: true, hijack: true,
    })

    this.stream.on('data', (chunk) => {
      this.output += chunk.toString('utf8')
    })

    await this.container.start()
    this.startedAt = Date.now()

    // Resize TTY wide so the URL doesn't wrap across lines
    await this.container.resize({ w: 500, h: 50 })

    this.log(`container started: ${this.container.id}`)

    // Poll accumulated output for the URL
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

    throw new Error('Timed out waiting for auth URL from claude setup-token')
  }

  /**
   * Writes the OAuth code to the container's stdin and waits for the
   * resulting token in the output.
   * @param {string} code - the OAuth code from the callback page
   * @param {object} options
   * @param {number} options.timeoutMs - max time to wait for token (default 30s)
   * @returns {Promise<string>} the OAuth token
   * @throws if token not found within timeout
   */
  async submitCode(code, { timeoutMs = 30000 } = {}) {
    if (!this.stream) throw new Error('No active session stream')

    // Record output length before writing so we only scan new output
    const outputLenBefore = this.output.length

    this.log('writing code to stdin')
    this.stream.write(code + '\r')

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500))

      const newOutput = this.output.slice(outputLenBefore).replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/[\x00-\x08]/g, '')
      const tokenMatch = newOutput.match(TOKEN_REGEX)
      if (tokenMatch) {
        this.log('OAuth token extracted')
        return tokenMatch[0]
      }

      // Check for error indicators
      if (newOutput.includes('error') || newOutput.includes('Error') || newOutput.includes('failed')) {
        const clean = newOutput.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, '').replace(/[\x00-\x09\x0b-\x1a\x1c-\x1f]/g, '').trim()
        if (clean && !clean.match(TOKEN_REGEX)) {
          this.log(`potential error in output: ${clean.substring(0, 200)}`)
        }
      }
    }

    throw new Error('Timed out waiting for OAuth token after code submission')
  }

  /**
   * Stops and removes the container, destroys the stream.
   */
  async cleanup() {
    if (this.stream) {
      try { this.stream.destroy() } catch {}
      this.stream = null
    }
    if (this.container) {
      try { await this.container.stop({ t: 2 }) } catch {}
      try { await this.container.remove() } catch {}
      this.container = null
    }
  }
}
