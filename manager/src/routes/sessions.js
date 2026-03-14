import { nanoid } from 'nanoid'
import { sessions, baseImages, settings } from '../services/db.js'
import {
  assignPort,
  startContainer,
  pauseContainer,
  unpauseContainer,
  stopAndRemoveContainer,
  getContainerLogs,
} from '../services/docker.js'

export default async function sessionRoutes(fastify) {
  // List all sessions
  fastify.get('/sessions', async () => {
    return sessions.getAll()
  })

  // Get single session
  fastify.get('/sessions/:id', async (req, reply) => {
    const session = sessions.getById(req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    return session
  })

  // SSH connection string
  fastify.get('/sessions/:id/ssh', async (req, reply) => {
    const session = sessions.getById(req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    const hostname = settings.get('tailscaleHostname') || 'your-unraid-host'
    return {
      command: `ssh -p ${session.sshPort} root@${hostname}`,
      hostname,
      port: session.sshPort,
      tmuxAttach: `tmux attach -t claude-main`,
      oneLiner: `ssh -p ${session.sshPort} root@${hostname} -t "tmux attach -t claude-main || tmux new-session -s claude-main"`,
    }
  })

  // Create session
  fastify.post('/sessions', async (req, reply) => {
    const { name, baseImageId, repos, permissionMode, spawnMode } = req.body

    if (!baseImageId) return reply.code(400).send({ error: 'baseImageId required' })
    if (!repos?.length) return reply.code(400).send({ error: 'At least one repo required' })

    const image = baseImages.getById(baseImageId)
    if (!image) return reply.code(400).send({ error: 'Base image not found' })

    const id = nanoid(10)
    const sshPort = assignPort()

    const session = sessions.create({
      id,
      name: name || repos.map(r => r.name).join(', '),
      status: 'starting',
      baseImageId,
      repos,
      sshPort,
      containerId: null,
    })

    // Start container async — don't block the response
    startContainer(session, image, { permissionMode, spawnMode })
      .then(containerId => {
        sessions.update(id, { containerId, status: 'running' })
      })
      .catch(err => {
        console.error('Failed to start container:', err)
        sessions.update(id, { status: 'error', errorMessage: err.message })
      })

    return reply.code(201).send(session)
  })

  // Container logs
  fastify.get('/sessions/:id/logs', async (req, reply) => {
    const session = sessions.getById(req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (!session.containerId) return reply.code(400).send({ error: 'No running container', logs: '' })

    const tail = Math.min(Math.max(parseInt(req.query.tail) || 200, 1), 10000)
    try {
      const logs = await getContainerLogs(session.containerId, tail)
      return { logs, tail }
    } catch (err) {
      return reply.code(500).send({ error: err.message, logs: '' })
    }
  })

  // Pause
  fastify.post('/sessions/:id/pause', async (req, reply) => {
    const session = sessions.getById(req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (session.status !== 'running') return reply.code(400).send({ error: `Cannot pause a ${session.status} session` })

    await pauseContainer(session.containerId)
    return sessions.update(session.id, { status: 'paused' })
  })

  // Resume (from pause)
  fastify.post('/sessions/:id/resume', async (req, reply) => {
    const session = sessions.getById(req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    if (session.status === 'paused') {
      await unpauseContainer(session.containerId)
      return sessions.update(session.id, { status: 'running' })
    }

    if (session.status === 'stopped') {
      // Restart: create a fresh container, repos persist via bind mount
      const image = baseImages.getById(session.baseImageId)
      if (!image) return reply.code(400).send({ error: 'Base image not found' })

      const containerId = await startContainer(session, image)
      return sessions.update(session.id, { containerId, status: 'running' })
    }

    return reply.code(400).send({ error: `Cannot resume a ${session.status} session` })
  })

  // Stop (container removed, repos persist on disk, can be restarted)
  fastify.post('/sessions/:id/stop', async (req, reply) => {
    const session = sessions.getById(req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    if (!['running', 'paused'].includes(session.status)) {
      return reply.code(400).send({ error: `Cannot stop a ${session.status} session` })
    }

    if (session.status === 'paused') {
      await unpauseContainer(session.containerId)
    }

    await stopAndRemoveContainer(session.containerId)
    return sessions.update(session.id, { status: 'stopped', containerId: null })
  })

  // Terminate (delete session entirely)
  fastify.delete('/sessions/:id', async (req, reply) => {
    const session = sessions.getById(req.params.id)
    if (!session) return reply.code(404).send({ error: 'Session not found' })

    if (session.containerId) {
      await stopAndRemoveContainer(session.containerId).catch(console.warn)
    }

    sessions.delete(session.id)
    return { deleted: true, id: session.id }
  })
}
