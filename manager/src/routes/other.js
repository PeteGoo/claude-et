import { nanoid } from 'nanoid'
import { baseImages, settings } from '../services/db.js'
import { listAvailableImages } from '../services/docker.js'
import { listRepos, createRepo, validateToken } from '../services/github.js'

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
    // Mask token — never send full token to UI
    return {
      ...all,
      githubToken: all.githubToken ? '••••••••' + all.githubToken.slice(-4) : '',
      githubTokenSet: !!all.githubToken,
    }
  })

  fastify.put('/settings', async (req, reply) => {
    const body = { ...req.body }
    // Don't overwrite token with masked value
    if (body.githubToken?.startsWith('••••')) {
      delete body.githubToken
    }
    return settings.setAll(body)
  })

  // Dedicated token endpoint so we don't accidentally expose it
  fastify.put('/settings/github-token', async (req, reply) => {
    const { token } = req.body
    if (!token) return reply.code(400).send({ error: 'token required' })
    settings.set('githubToken', token)
    const validation = await validateToken().catch(err => ({ valid: false, error: err.message }))
    return { saved: true, ...validation }
  })
}
