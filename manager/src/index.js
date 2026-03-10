import Fastify from 'fastify'
import cors from '@fastify/cors'
import staticFiles from '@fastify/static'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'

import sessionRoutes from './routes/sessions.js'
import { imageRoutes, githubRoutes, settingsRoutes } from './routes/other.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined,
  },
})

await fastify.register(cors, {
  origin: true, // tighten in production if needed
})

// ─── API routes ───────────────────────────────────────────────────────────────

await fastify.register(async (api) => {
  await api.register(sessionRoutes)
  await api.register(imageRoutes)
  await api.register(githubRoutes)
  await api.register(settingsRoutes)
}, { prefix: '/api' })

// ─── Health check ─────────────────────────────────────────────────────────────

fastify.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }))

// ─── Serve React UI (production build) ───────────────────────────────────────

// Check bundled location (Docker) first, then dev location
const uiDist = existsSync(join(__dirname, '../ui-dist'))
  ? join(__dirname, '../ui-dist')
  : join(__dirname, '../../ui/dist')
if (existsSync(uiDist)) {
  await fastify.register(staticFiles, {
    root: uiDist,
    prefix: '/',
  })
  // SPA fallback
  fastify.setNotFoundHandler((req, reply) => {
    reply.sendFile('index.html')
  })
} else {
  fastify.get('/', async () => ({
    message: 'Claude Session Manager API',
    ui: 'Run `npm run build` in /ui to serve the web interface',
  }))
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await fastify.listen({ port: PORT, host: HOST })
  console.log(`Claude Session Manager running at http://${HOST}:${PORT}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
