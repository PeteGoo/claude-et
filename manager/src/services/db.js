import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DATA_DIR = process.env.DATA_DIR || '/data'
mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(join(DATA_DIR, 'sessions.db'))

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    base_image_id TEXT NOT NULL,
    repos TEXT NOT NULL DEFAULT '[]',
    ssh_port INTEGER,
    container_id TEXT,
    checkpoint_path TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS base_images (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    docker_image TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// ─── Default base images ──────────────────────────────────────────────────────

const defaultImages = [
  {
    id: 'default-node20',
    alias: 'Node 20 + Claude Code',
    dockerImage: 'ghcr.io/petegoo/claude-et-session:latest',
    description: 'Default Node.js 20 environment with Claude Code',
  },
  {
    id: 'default-dotnet',
    alias: '.NET 9 + Node 20 + Claude Code',
    dockerImage: 'ghcr.io/petegoo/claude-et-session-dotnet:latest',
    description: '.NET 9 SDK with Node.js 20 and Claude Code',
  },
]

for (const img of defaultImages) {
  const exists = db.prepare(`SELECT id FROM base_images WHERE id = ?`).get(img.id)
  if (!exists) {
    db.prepare(`
      INSERT INTO base_images (id, alias, docker_image, description)
      VALUES (@id, @alias, @dockerImage, @description)
    `).run(img)
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

function rowToSession(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    baseImageId: row.base_image_id,
    repos: JSON.parse(row.repos),
    sshPort: row.ssh_port,
    containerId: row.container_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  }
}

export const sessions = {
  getAll() {
    return db.prepare(`SELECT * FROM sessions ORDER BY last_active_at DESC`).all().map(rowToSession)
  },

  getById(id) {
    return rowToSession(db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id))
  },

  create(session) {
    db.prepare(`
      INSERT INTO sessions (id, name, status, base_image_id, repos, ssh_port, container_id)
      VALUES (@id, @name, @status, @baseImageId, @repos, @sshPort, @containerId)
    `).run({
      id: session.id,
      name: session.name,
      status: session.status,
      baseImageId: session.baseImageId,
      repos: JSON.stringify(session.repos),
      sshPort: session.sshPort,
      containerId: session.containerId || null,
    })
    return sessions.getById(session.id)
  },

  update(id, fields) {
    const updates = []
    const values = {}

    if (fields.status !== undefined) { updates.push('status = @status'); values.status = fields.status }
    if (fields.containerId !== undefined) { updates.push('container_id = @containerId'); values.containerId = fields.containerId }
    if (fields.errorMessage !== undefined) { updates.push('error_message = @errorMessage'); values.errorMessage = fields.errorMessage }

    updates.push("last_active_at = datetime('now')")
    values.id = id

    if (updates.length > 1) {
      db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = @id`).run(values)
    }
    return sessions.getById(id)
  },

  delete(id) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
  },
}

// ─── Base Images ──────────────────────────────────────────────────────────────

function rowToImage(row) {
  if (!row) return null
  return {
    id: row.id,
    alias: row.alias,
    dockerImage: row.docker_image,
    description: row.description,
    createdAt: row.created_at,
  }
}

export const baseImages = {
  getAll() {
    return db.prepare(`SELECT * FROM base_images ORDER BY alias`).all().map(rowToImage)
  },

  getById(id) {
    return rowToImage(db.prepare(`SELECT * FROM base_images WHERE id = ?`).get(id))
  },

  create(image) {
    db.prepare(`
      INSERT INTO base_images (id, alias, docker_image, description)
      VALUES (@id, @alias, @dockerImage, @description)
    `).run(image)
    return baseImages.getById(image.id)
  },

  update(id, fields) {
    const updates = []
    const values = { id }
    if (fields.alias) { updates.push('alias = @alias'); values.alias = fields.alias }
    if (fields.dockerImage) { updates.push('docker_image = @dockerImage'); values.dockerImage = fields.dockerImage }
    if (fields.description !== undefined) { updates.push('description = @description'); values.description = fields.description }
    if (updates.length) {
      db.prepare(`UPDATE base_images SET ${updates.join(', ')} WHERE id = @id`).run(values)
    }
    return baseImages.getById(id)
  },

  delete(id) {
    db.prepare(`DELETE FROM base_images WHERE id = ?`).run(id)
  },
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULTS = {
  githubToken: '',
  githubOrg: '',
  tailscaleHostname: '',
  sessionsPath: '/mnt/user/claude-sessions',
  gitEmail: 'claude-session@localhost',
  gitName: 'Claude Session',
  sshPublicKey: '',
  claudeCredentials: '',
  claudeOauthToken: '',
}

export const settings = {
  getAll() {
    const rows = db.prepare(`SELECT key, value FROM settings`).all()
    const stored = Object.fromEntries(rows.map(r => [r.key, r.value]))
    return { ...DEFAULTS, ...stored }
  },

  get(key) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)
    return row ? row.value : DEFAULTS[key] ?? null
  },

  set(key, value) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, String(value))
  },

  setAll(obj) {
    const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    const tx = db.transaction((data) => {
      for (const [k, v] of Object.entries(data)) {
        upsert.run(k, String(v ?? ''))
      }
    })
    tx(obj)
    return settings.getAll()
  },
}

export default db
