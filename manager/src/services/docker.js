import Docker from 'dockerode'
import { sessions, settings } from './db.js'
import { mkdirSync } from 'fs'
import { join } from 'path'

const docker = new Docker({ socketPath: '/var/run/docker.sock' })

// ─── Port management ──────────────────────────────────────────────────────────

const PORT_RANGE = { min: 30000, max: 60000 }

function getUsedPorts() {
  return new Set(sessions.getAll().map(s => s.sshPort).filter(Boolean))
}

export function assignPort() {
  const used = getUsedPorts()
  let port
  do {
    port = Math.floor(Math.random() * (PORT_RANGE.max - PORT_RANGE.min)) + PORT_RANGE.min
  } while (used.has(port))
  return port
}

// ─── Session repo env string ──────────────────────────────────────────────────
// Format: "name:cloneUrl:clone,name::new"

function buildRepoEnv(repos) {
  return repos.map(r => {
    if (r.type === 'clone') return `${r.name}:${r.cloneUrl}:clone`
    return `${r.name}::new`
  }).join(',')
}

// ─── Container operations ─────────────────────────────────────────────────────

export async function startContainer(session, baseImage) {
  const config = settings.getAll()
  const sessionsPath = config.sessionsPath || '/mnt/user/claude-sessions'
  const sessionDir = join(sessionsPath, session.id)
  const reposDir = join(sessionDir, 'repos')

  mkdirSync(reposDir, { recursive: true })

  const pushToGitHub = session.repos.some(r => r.type === 'new' && r.pushToGitHub)

  const container = await docker.createContainer({
    name: `claude-session-${session.id}`,
    Image: baseImage.dockerImage,
    Env: [
      `GITHUB_TOKEN=${config.githubToken}`,
      `GITHUB_ORG=${config.githubOrg}`,
      `GIT_EMAIL=${config.gitEmail}`,
      `GIT_NAME=${config.gitName}`,
      `SSH_PUBLIC_KEY=${config.sshPublicKey || ''}`,
      `SESSION_REPOS=${buildRepoEnv(session.repos)}`,
      `PUSH_TO_GITHUB=${pushToGitHub ? 'true' : 'false'}`,
      `TMUX_SESSION=claude-main`,
    ],
    HostConfig: {
      PortBindings: {
        '22/tcp': [{ HostPort: String(session.sshPort) }],
      },
      Binds: [
        `${reposDir}:/repos`,
      ],
      RestartPolicy: { Name: 'no' },
    },
    ExposedPorts: { '22/tcp': {} },
  })

  await container.start()
  return container.id
}

export async function pauseContainer(containerId) {
  const container = docker.getContainer(containerId)
  await container.pause()
}

export async function unpauseContainer(containerId) {
  const container = docker.getContainer(containerId)
  await container.unpause()
}

export async function stopAndRemoveContainer(containerId) {
  try {
    const container = docker.getContainer(containerId)
    await container.stop({ t: 5 })
    await container.remove()
  } catch (err) {
    // Container may already be gone
    if (!err.message?.includes('No such container')) {
      throw err
    }
  }
}

export async function getContainerStatus(containerId) {
  try {
    const container = docker.getContainer(containerId)
    const info = await container.inspect()
    return info.State
  } catch {
    return null
  }
}

export async function listAvailableImages() {
  const images = await docker.listImages()
  return images.flatMap(img => img.RepoTags || []).filter(t => t !== '<none>:<none>')
}
