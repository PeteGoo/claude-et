# Claude E.T. Authentication — How It Works (and Why)

This document explains how Claude E.T. authenticates with Claude Code's OAuth system. It exists because getting this right was extremely difficult, and future developers (including future-us) should understand the constraints before attempting changes.

## TL;DR

We spin up a temporary Docker container, run `claude` interactively with a TTY, auto-navigate the onboarding prompts by spamming Enter, extract the OAuth URL from the TTY output (reassembling it from line-wrapped fragments), show it to the user in the UI, accept a code paste from the user, write the code to the container's TTY stdin, then poll the container for `.credentials.json`. The credentials are saved to the database and bind-mounted into session containers.

If that sounds convoluted, it is. Read on to understand why every simpler approach failed.

---

## The Core Problem

Claude Code sessions need the `user:sessions:claude_code` OAuth scope to run `claude remote-control`. This scope is only available through the interactive `claude` login flow — **not** through `claude setup-token`.

## What We Tried (and Why It Failed)

### 1. `claude setup-token` with URL rewriting

**Approach:** Use `claude setup-token` (which accepts a token via stdin) but rewrite the OAuth URL to request additional scopes.

**Why it failed:** The OAuth server validates that the scopes in the authorization URL match the scopes in the code exchange. Requesting `user:sessions:claude_code` at the URL but exchanging via `setup-token` (which only knows about `user:inference`) causes a scope mismatch and the server rejects the code exchange.

### 2. `claude auth login` (server-side polling)

**Approach:** Run `claude auth login` in a container. It produces an OAuth URL with all the right scopes and polls server-side for completion.

**Why it failed:** `claude auth login` does **server-side polling** — it does not accept a code paste via stdin. It shows a URL, the user authorizes in the browser, and the CLI is supposed to detect completion automatically. However, the server-side polling never detected completion in our container environment. The flow would hang at "Waiting for authorization..." indefinitely. We confirmed the exec stream was writable and writes were going through, but `claude auth login` simply ignores stdin — it doesn't have a code paste prompt.

### 3. `claude` interactive (what actually works)

**Approach:** Run the full interactive `claude` command (not `claude auth login`) in a container with a TTY. Navigate through onboarding prompts automatically, extract the auth URL, and accept the code paste via the TTY's stdin.

**Why it works:** The interactive `claude` command has a "Paste code here" prompt and reads from the TTY (which docker exec with `Tty: true` provides). Writing the code + `\r` (carriage return, not `\n`) to the exec stream delivers it to the process.

**Additional hurdles solved:**
- **Onboarding prompts:** Even with `{"hasCompletedOnboarding": true}` in settings.json, `claude` still shows theme selection, syntax demo, and subscription prompts. We send `\r` every poll interval to navigate through them automatically.
- **TTY line wrapping:** The OAuth URL is very long and gets wrapped across multiple lines by the TTY. Our URL regex (`/https:\/\/[^\s]+/`) would only capture the first line fragment. Fix: collapse all whitespace from the output before matching.
- **ANSI escape codes:** Container output is full of ANSI color/cursor codes that corrupt URL and token extraction. Fix: strip with `/\x1b\[[^a-zA-Z]*[a-zA-Z]/g` before processing.
- **Enter spam vs URL capture:** Sending Enter on every poll iteration to navigate onboarding would also advance past the auth URL screen before we could capture it. Fix: stop sending Enter once we detect `claude.ai/oauth` in the output.

### Other things that don't work

- **Writing to stdin fd 0:** `claude auth login` reads from `/dev/tty`, not stdin fd 0. Piping, heredocs, and stdin redirection are all ignored.
- **TIOCSTI ioctl:** Faking keypresses via ioctl is blocked in modern Linux kernels (≥5.x).
- **FIFO/named pipe as /dev/tty:** Cannot replace `/dev/tty` inside a container.
- **Python PTY module:** Added complexity without solving the core problem.

---

## The Working Architecture

### Login Flow (credential acquisition)

```
User clicks "Renew via login" in UI
        │
        ▼
POST /auth/login-start
        │
        ├── Create temporary container from session-base image
        │     Entrypoint: bash -c 'mkdir -p /root/.claude &&
        │       echo {"hasCompletedOnboarding":true} > settings.json && sleep 300'
        │
        ├── Docker exec: `claude` with TTY (AttachStdin + Tty: true)
        │     Stream captured via hijack mode
        │
        ├── Poll loop (every 2s, 60s deadline):
        │     1. Strip ANSI codes and control chars from output
        │     2. If no URL fragment detected → send \r to advance onboarding
        │     3. Collapse whitespace, match URL regex
        │     4. Return URL when found
        │
        └── Return { authUrl } to UI
        │
        ▼
User opens URL in browser, authorizes, receives a code
        │
        ▼
POST /auth/login-code  { code: "..." }
        │
        └── Write code + \r to exec stream's TTY stdin
        │
        ▼
GET /auth/login-poll  (UI polls every 3s)
        │
        ├── Docker exec: cat /root/.claude/.credentials.json
        │     Strip Docker stream headers, extract JSON
        │     Validate: must contain claudeAiOauth key
        │
        ├── If not found → { status: "pending" }
        │
        └── If found:
              ├── Save full JSON to DB (settings.claudeCredentials)
              ├── Clear legacy claudeOauthToken
              ├── Cleanup temp container (stop + remove)
              └── Return { status: "complete", credentials: summary }
```

### Session startup (credential usage)

```
startContainer() in docker.js
        │
        ├── Read claudeCredentials from DB
        │
        ├── If claudeOauthToken exists:
        │     Pass as CLAUDE_CODE_OAUTH_TOKEN env var (legacy path)
        │
        ├── If claudeCredentials exists (preferred path):
        │     Write to {sessionDir}/.claude/.credentials.json (mode 0600)
        │     Bind-mount into container at /root/.claude/.credentials.json
        │
        ▼
entrypoint.sh in session container
        │
        ├── Read /root/.claude/.credentials.json
        ├── Extract subscription type
        ├── Populate /root/.claude.json with account info
        ├── Set hasCompletedOnboarding: true
        ├── Pre-trust project directories
        │
        └── Launch: claude remote-control --name <session> --permission-mode <mode>
              (pre-authenticated via bind-mounted credentials)
```

---

## Key Files

| File | Role |
|------|------|
| `manager/src/services/auth-login.js` | `LoginFlowSession` class — container lifecycle, URL extraction, code submission, credential polling |
| `manager/src/routes/other.js` | REST endpoints: `/auth/login-start`, `/auth/login-code`, `/auth/login-poll`, `/auth/login-cancel`, credential CRUD |
| `manager/src/services/docker.js` | `startContainer()` — writes credentials to disk, bind-mounts into session containers |
| `ui/src/App.jsx` | `LoginFlowModal` component — UI state machine for the auth flow |
| `images/base/entrypoint.sh` | Session container init — reads credentials, configures Claude Code, launches remote-control |
| `manager/src/services/db.js` | SQLite storage for `claudeCredentials`, `claudeOauthToken`, `githubToken` |

## Credential Format

The `.credentials.json` file has this structure:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": "2026-03-16T06:00:00.000Z",
    "subscriptionType": "pro"
  }
}
```

- **Access tokens** expire in ~8 hours
- **Refresh tokens** allow Claude Code to automatically renew access tokens
- The full JSON is stored in the DB and bind-mounted into containers — Claude Code handles refresh internally

## Critical Constraints

1. **`claude auth login` does NOT accept code paste.** It does server-side polling only. Do not try to write codes to it.
2. **`claude setup-token` only gets `user:inference` scope.** This is insufficient for `claude remote-control`. Do not try to add scopes — the server rejects mismatched scope exchanges.
3. **The interactive `claude` command reads from `/dev/tty`, not stdin.** Docker exec with `Tty: true` makes this work because the allocated PTY becomes the controlling terminal.
4. **TTY mode needs `\r` (carriage return), not `\n` (newline).** A `\n` does nothing in TTY mode.
5. **Long URLs get line-wrapped by the TTY.** You must collapse whitespace before regex matching or you'll get truncated URLs.
6. **`hasCompletedOnboarding: true` does NOT skip onboarding** in the interactive `claude` command. You must auto-navigate the prompts.
7. **ANSI escape sequences corrupt everything.** Always strip them before extracting URLs or tokens from container output.

## Integration Testing

The integration test (`auth-login.integration.test.js`) uses `claude auth login` (not `claude` interactive) via the `cmd` constructor option. This is because:
- `claude auth login` reliably produces a URL without onboarding prompts
- The integration test only validates URL extraction, not code submission
- Running `claude` interactive in CI gets stuck on onboarding with no TTY interaction

```javascript
const session = new LoginFlowSession({
  cmd: ['claude', 'auth', 'login'],  // Override for CI
  image: TEST_IMAGE,
})
```
