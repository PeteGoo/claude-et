# Claude Session Manager

Remote Claude Code session manager for Unraid. Spin up isolated coding environments, pause/suspend/resume them at will, and connect via SSH + tmux from anywhere on your Tailscale network.

## Architecture

```
Unraid Host
├── claude-session-manager  (this app — manager API + web UI)
└── claude-session-*        (one container per coding session)
    ├── SSH on random port 30000-60000
    ├── tmux session "claude-main"
    ├── Claude Code running inside tmux
    └── /repos/* mounted from host
```

## Prerequisites

1. **Unraid** with Docker enabled
2. **CRIU** on the Unraid host kernel (check: `criu check`)
3. **Docker experimental features** enabled for checkpoint support:
   ```
   # /etc/docker/daemon.json
   { "experimental": true }
   ```
4. **Tailscale** installed on Unraid
5. A **GitHub Personal Access Token** with `repo` + `admin:org` scopes

## Quick Start

### 1. Build the session base image

```bash
cd session-image
docker build -t claude-session:node20 .
```

### 2. Build and start the manager

```bash
# From repo root
docker compose up -d --build
```

### 3. Open the UI

Navigate to `http://your-unraid-ip:3000` or via Tailscale.

### 4. Configure Settings

- Add your GitHub token
- Set your Tailscale hostname (e.g. `your-unraid.tailnet.ts.net`)
- Paste your SSH public key (`cat ~/.ssh/id_ed25519.pub`)
- Confirm sessions storage path

### 5. Create a session

Click **+ New Session**, pick an environment, select repos, launch.

### 6. Connect

Click the terminal icon on any running session to get the SSH command:

```bash
ssh -p 41829 root@your-unraid.tailnet.ts.net -t "tmux attach -t claude-main"
```

---

## GitHub Push from Sessions

Git push works automatically. The GitHub token configured in Settings is injected into each container as a credential helper. No SSH keys or per-container setup required — `git push` just works.

---

## Session States

| State | RAM | CPU | Description |
|-------|-----|-----|-------------|
| `running` | Used | Used | Active, connectable |
| `paused` | Used | **0** | Frozen, instant resume |
| `suspended` | **Freed** | **0** | CRIU checkpoint on disk |
| `stopped` | Freed | 0 | Terminated, checkpoint may remain |

**Pause** is instant (milliseconds). Use it for short breaks.  
**Suspend** takes a few seconds (CRIU checkpoint). Use it to free RAM overnight.

---

## Custom Base Images

Add your own Docker images in Settings → Base Images. The image must include:
- `openssh-server`
- `tmux`
- `git`

And use the provided `entrypoint.sh` pattern (or adapt it). The manager injects env vars at container start — see `session-image/entrypoint.sh` for the full contract.

---

## API

The REST API is available at `/api/*` — same host as the UI.

```
GET    /api/sessions
POST   /api/sessions          { name, baseImageId, repos[] }
GET    /api/sessions/:id/ssh  → SSH connection strings
POST   /api/sessions/:id/pause
POST   /api/sessions/:id/resume
POST   /api/sessions/:id/suspend
DELETE /api/sessions/:id

GET    /api/images
POST   /api/images            { alias, dockerImage, description }

GET    /api/github/repos
GET    /api/settings
PUT    /api/settings
PUT    /api/settings/github-token  { token }
```

Ready for MCP tool wrapping — each action maps cleanly to a tool.

---

## Directory Structure

```
claude-session-manager/
├── session-image/
│   ├── Dockerfile          # Base container image
│   └── entrypoint.sh       # Repo setup + tmux + Claude Code launch
├── manager/
│   ├── Dockerfile          # Manager + UI combined image
│   ├── package.json
│   └── src/
│       ├── index.js         # Fastify server
│       ├── routes/
│       │   ├── sessions.js
│       │   └── other.js     # images, github, settings
│       └── services/
│           ├── db.js        # SQLite (sessions, images, settings)
│           ├── docker.js    # Container lifecycle
│           └── github.js    # Octokit wrapper
├── ui/
│   └── src/App.jsx          # Full React UI
└── docker-compose.yml
```
