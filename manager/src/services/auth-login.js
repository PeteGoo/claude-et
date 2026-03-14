/**
 * Polls a container's logs for an auth URL from `claude login`.
 *
 * @param {object} container - dockerode container object
 * @param {object} options
 * @param {number} options.deadlineMs - how long to poll (ms)
 * @param {number} options.pollIntervalMs - interval between polls (ms)
 * @param {function} [options.log] - optional logging function
 * @returns {Promise<{authUrl: string}|null>}
 */
export async function pollContainerForAuthUrl(container, { deadlineMs = 60000, pollIntervalMs = 2000, log } = {}) {
  const deadline = Date.now() + deadlineMs

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs))

    // Check container is still running
    const inspect = await container.inspect()
    const status = inspect.State.Status
    if (log) log(`container status: ${status}`)
    if (status === 'exited' || status === 'dead') {
      if (log) log(`container exited prematurely (exit code ${inspect.State.ExitCode})`)
      return null
    }

    const logBuffer = await container.logs({ stdout: true, stderr: true, tail: 50 })
    const logs = typeof logBuffer === 'string' ? logBuffer : logBuffer.toString('utf8')
    // Strip Docker stream headers (8-byte prefix per frame when Tty is false)
    const cleanLogs = logs.replace(/[\x00-\x08]/g, '').trim()
    if (log) log(`logs (${logBuffer.length} bytes): ${cleanLogs.substring(0, 500)}`)

    const match = cleanLogs.match(/https:\/\/[^\s]+/)
    if (match) {
      return { authUrl: match[0] }
    }
  }

  return null
}
