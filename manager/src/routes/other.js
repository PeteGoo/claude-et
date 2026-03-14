import { nanoid } from 'nanoid'
import Docker from 'dockerode'
import { baseImages, settings } from '../services/db.js'
import { listAvailableImages, execInContainer, updateAllSessionCredentials } from '../services/docker.js'
import { listRepos, createRepo, validateToken } from '../services/github.js'

const docker = new Docker({ socketPath: '/var/run/docker.sock' })

let loginFlowState = null

// ─── Base Images ──────────────────────────────────────────────────────────────

export async function imageRoutes(fastify) {
  fastify.get('/images', async () => {
    return baseImages.getAll()
  })

  fastify.post('/images', async (req, reply) => {
    const { alias, dockerImage, description } = req.body
    if (!alias || !dockerImage) return reply.code(400).send({ error: 'alias and dockerImage required' })
    const image = baseImages.create({ id: nanoid(10), alias, dockerImage, description: description || '' })
    return reply.code(201).send(image)
  })

  fastify.put('/images/:id', async (req, reply) => {
    const image = baseImages.getById(req.params.id)
    if (!image) return reply.code(404).send({ error: 'Image not found' })
    return baseImages.update(req.params.id, req.body)
  })

  fastify.delete('/images/:id', async (req, reply) => {
    const image = baseImages.getById(req.params.id)
    if (!image) return reply.code(404).send({ error: 'Image not found' })
    baseImages.delete(req.params.id)
    return { deleted: true }
  })

  // List Docker images available on the host (for the image picker in settings)
  fastify.get('/images/docker-available', async () => {
    return listAvailableImages()
  })
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

export async function githubRoutes(fastify) {
  fastify.get('/github/repos', async (req, reply) => {
    try {
      return await listRepos()
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    }
  })

  fastify.post('/github/repos', async (req, reply) => {
    const { name, private: isPrivate = true } = req.body
    if (!name) return reply.code(400).send({ error: 'name required' })
    try {
      const repo = await createRepo(name, isPrivate)
      return reply.code(201).send(repo)
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    }
  })

  fastify.get('/github/validate', async (req, reply) => {
    try {
      return await validateToken()
    } catch (err) {
      return reply.code(400).send({ error: err.message })
    }
  })
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function settingsRoutes(fastify) {
  fastify.get('/settings', async () => {
    const all = settings.getAll()
    const claudeCredsLength = all.claudeCredentials ? all.claudeCredentials.length : 0
    console.log(`[settings] claudeCredentials stored: ${claudeCredsLength} bytes`)
    // Mask secrets — never send full values to UI
    return {
      ...all,
      githubToken: all.githubToken ? '••••••••' + all.githubToken.slice(-4) : '',
      githubTokenSet: !!all.githubToken,
      claudeCredentials: undefined,
      claudeCredentialsSet: !!all.claudeCredentials,
      claudeCredentialsSummary: summariseClaudeCredentials(all.claudeCredentials),
    }
  })

  fastify.put('/settings', async (req, reply) => {
    const body = { ...req.body }
    // Don't overwrite secrets with masked/placeholder values
    if (body.githubToken?.startsWith('••••')) {
      delete body.githubToken
    }
    // Remove computed/secret fields handled by dedicated endpoints
    delete body.claudeCredentials
    delete body.claudeCredentialsSet
    delete body.claudeCredentialsSummary
    delete body.githubTokenSet
    return settings.setAll(body)
  })

  // Diagnostic: check if credentials are actually stored
  fastify.get('/settings/claude-credentials/status', async () => {
    const raw = settings.get('claudeCredentials')
    return {
      stored: !!raw,
      length: raw ? raw.length : 0,
      validJson: (() => { try { JSON.parse(raw); return true } catch { return false } })(),
      hasOauthToken: (() => { try { return !!JSON.parse(raw)?.claudeAiOauth?.accessToken } catch { return false } })(),
    }
  })

  // Dedicated token endpoint so we don't accidentally expose it
  fastify.put('/settings/github-token', async (req, reply) => {
    const { token } = req.body
    if (!token) return reply.code(400).send({ error: 'token required' })
    settings.set('githubToken', token)
    const validation = await validateToken().catch(err => ({ valid: false, error: err.message }))
    return { saved: true, ...validation }
  })

  // Claude credentials endpoint
  fastify.put('/settings/claude-credentials', async (req, reply) => {
    const { credentials } = req.body
    console.log(`[claude-creds] PUT received, credentials type: ${typeof credentials}, length: ${credentials?.length ?? 'null'}`)
    if (!credentials) return reply.code(400).send({ error: 'credentials required' })
    // Validate it's valid JSON with the expected shape
    try {
      const parsed = JSON.parse(credentials)
      if (!parsed.claudeAiOauth?.accessToken) {
        console.log('[claude-creds] Validation failed: missing claudeAiOauth.accessToken')
        return reply.code(400).send({ error: 'Invalid credentials: missing claudeAiOauth.accessToken' })
      }
      console.log(`[claude-creds] Validation passed, subscription: ${parsed.claudeAiOauth.subscriptionType}`)
    } catch (e) {
      console.log(`[claude-creds] JSON parse failed: ${e.message}`)
      return reply.code(400).send({ error: 'Invalid JSON' })
    }
    settings.set('claudeCredentials', credentials)
    console.log(`[claude-creds] Saved ${credentials.length} bytes to DB`)
    // Verify it was saved
    const verify = settings.get('claudeCredentials')
    console.log(`[claude-creds] Verify read-back: ${verify?.length ?? 0} bytes`)
    return { saved: true, ...summariseClaudeCredentials(credentials) }
  })

  fastify.delete('/settings/claude-credentials', async (req, reply) => {
    settings.set('claudeCredentials', '')
    return { deleted: true }
  })

  // Lightweight credential status for polling
  fastify.get('/credentials-status', async () => {
    const raw = settings.get('claudeCredentials')
    if (!raw) return { configured: false }
    return { configured: true, ...summariseClaudeCredentials(raw) }
  })

  // ─── Auth Login Flow ─────────────────────────────────────────────────────────

  fastify.post('/auth/login-start', async (req, reply) => {
    if (loginFlowState) {
      return reply.code(409).send({ error: 'A login flow is already in progress' })
    }

    const images = baseImages.getAll()
    if (!images.length) {
      return reply.code(400).send({ error: 'No base images configured. Add one in Settings → Base Images first.' })
    }

    const baseImage = images[0]

    try {
      const container = await docker.createContainer({
        Image: baseImage.dockerImage,
        Cmd: ['bash', '-c', 'claude login 2>&1 && tail -f /dev/null'],
        Tty: true,
        HostConfig: {
          RestartPolicy: { Name: 'no' },
        },
      })

      await container.start()
      const containerId = container.id

      // Poll logs for auth URL (up to 15 seconds)
      let authUrl = null
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000))
        const logBuffer = await container.logs({ stdout: true, stderr: true, tail: 50 })
        const logs = typeof logBuffer === 'string' ? logBuffer : logBuffer.toString('utf8')
        const match = logs.match(/https:\/\/[^\s]+/)
        if (match) {
          authUrl = match[0]
          break
        }
      }

      if (!authUrl) {
        // Cleanup on failure to find URL
        try { await container.stop({ t: 2 }) } catch {}
        try { await container.remove() } catch {}
        return reply.code(500).send({ error: 'Timed out waiting for auth URL from claude login' })
      }

      loginFlowState = { containerId, startedAt: Date.now() }
      return { containerId, authUrl }
    } catch (err) {
      return reply.code(500).send({ error: err.message })
    }
  })

  fastify.get('/auth/login-status', async (req, reply) => {
    if (!loginFlowState) {
      return reply.code(400).send({ error: 'No login flow in progress' })
    }

    const { containerId, startedAt } = loginFlowState

    // Timeout after 5 minutes
    if (Date.now() - startedAt > 5 * 60 * 1000) {
      try {
        const container = docker.getContainer(containerId)
        await container.stop({ t: 2 })
        await container.remove()
      } catch {}
      loginFlowState = null
      return { status: 'timeout' }
    }

    try {
      const output = await execInContainer(containerId, ['cat', '/root/.claude/.credentials.json'])
      // Strip docker stream header bytes - look for first { character
      const jsonStart = output.indexOf('{')
      if (jsonStart === -1) {
        return { status: 'waiting' }
      }
      const jsonStr = output.slice(jsonStart)
      const parsed = JSON.parse(jsonStr)
      if (parsed.claudeAiOauth?.accessToken) {
        return { status: 'complete', credentials: jsonStr }
      }
      return { status: 'waiting' }
    } catch {
      return { status: 'waiting' }
    }
  })

  fastify.post('/auth/login-complete', async (req, reply) => {
    const { credentials } = req.body
    if (!credentials) return reply.code(400).send({ error: 'credentials required' })

    // Save to DB
    settings.set('claudeCredentials', credentials)

    // Update all running sessions
    const updated = updateAllSessionCredentials(credentials)

    // Cleanup temp container
    if (loginFlowState) {
      try {
        const container = docker.getContainer(loginFlowState.containerId)
        await container.stop({ t: 2 })
        await container.remove()
      } catch {}
      loginFlowState = null
    }

    return { saved: true, sessionsUpdated: updated, ...summariseClaudeCredentials(credentials) }
  })

  fastify.post('/auth/login-cancel', async (req, reply) => {
    if (!loginFlowState) return { cancelled: false }

    try {
      const container = docker.getContainer(loginFlowState.containerId)
      await container.stop({ t: 2 })
      await container.remove()
    } catch {}
    loginFlowState = null
    return { cancelled: true }
  })
}

function summariseClaudeCredentials(raw) {
  if (!raw) return null
  try {
    const creds = JSON.parse(raw)
    const oauth = creds.claudeAiOauth
    if (!oauth) return null
    return {
      subscriptionType: oauth.subscriptionType || 'unknown',
      expiresAt: oauth.expiresAt ? new Date(oauth.expiresAt).toISOString() : null,
      hasRefreshToken: !!oauth.refreshToken,
    }
  } catch {
    return null
  }
}
