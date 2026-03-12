import Docker from 'dockerode'
import { sessions, settings } from './db.js'
import { mkdirSync, writeFileSync } from 'fs'
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

  // Write Claude credentials file if configured
  const binds = [`${reposDir}:/repos`]
  if (config.claudeCredentials) {
    const claudeDir = join(sessionDir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const credsPath = join(claudeDir, '.credentials.json')
    writeFileSync(credsPath, config.claudeCredentials, { mode: 0o600 })
    binds.push(`${credsPath}:/root/.claude/.credentials.json:ro`)
  }

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
      Binds: binds,
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

export async function getContainerLogs(containerId, tail = 200) {
  const container = docker.getContainer(containerId)
  const logBuffer = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  })
  // Docker multiplexed stream: each frame has 8-byte header
  // We need to strip the header bytes from each frame
  const raw = typeof logBuffer === 'string' ? logBuffer : logBuffer.toString('utf8')
  return raw
}

export async function listAvailableImages() {
  const images = await docker.listImages()
  return images.flatMap(img => img.RepoTags || []).filter(t => t !== '<none>:<none>')
}

// ─── Status sync ──────────────────────────────────────────────────────────────
// Polls actual Docker state and updates the DB if a container has crashed/stopped

export async function syncSessionStatuses() {
  const allSessions = sessions.getAll()

  for (const session of allSessions) {
    if (!session.containerId) continue
    if (!['running', 'starting', 'paused'].includes(session.status)) continue

    const state = await getContainerStatus(session.containerId)

    if (!state) {
      // Container no longer exists
      sessions.update(session.id, { status: 'stopped', containerId: null, errorMessage: 'Container disappeared' })
      continue
    }

    if (state.Dead || (!state.Running && !state.Paused)) {
      const exitCode = state.ExitCode
      const errorMsg = exitCode !== 0
        ? `Container exited with code ${exitCode}${state.Error ? ': ' + state.Error : ''}`
        : 'Container stopped'
      // Clean up the dead container
      try {
        const container = docker.getContainer(session.containerId)
        await container.remove({ force: true })
      } catch { /* already gone */ }
      sessions.update(session.id, { status: 'stopped', containerId: null, errorMessage: errorMsg })
    }
  }
}
