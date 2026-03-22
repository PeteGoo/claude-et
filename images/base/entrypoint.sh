#!/bin/bash
set -e

# ─── Git identity (always set, needed for commits) ───────────────────────────
git config --global user.email "${GIT_EMAIL:-claude-session@localhost}"
git config --global user.name "${GIT_NAME:-Claude Session}"
git config --global init.defaultBranch main

# ─── Git credential setup ────────────────────────────────────────────────────
# This lets 'git push' work using the GitHub token without any interactive auth
if [ -n "$GITHUB_TOKEN" ]; then
    git config --global credential.helper store
    git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# ─── SSH: install authorized key if provided ─────────────────────────────────
if [ -n "$SSH_PUBLIC_KEY" ]; then
    echo "$SSH_PUBLIC_KEY" >> /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
fi

# Start SSH daemon
/usr/sbin/sshd

# ─── Repo setup ──────────────────────────────────────────────────────────────
# SESSION_REPOS format: "name|url|type,name||new"
# type = "clone" | "new"
# For new repos, url is empty
# Uses '|' as field separator to avoid conflicts with ':' in URLs

if [ -n "$SESSION_REPOS" ]; then
    echo "Setting up repos..."
    IFS=',' read -ra REPO_ENTRIES <<< "$SESSION_REPOS"

    for entry in "${REPO_ENTRIES[@]}"; do
        IFS='|' read -r name url type <<< "$entry"
        
        if [ "$type" = "clone" ] && [ -n "$url" ]; then
            echo "Cloning $name from $url..."
            cd /repos
            git clone "$url" "$name" || echo "WARNING: Failed to clone $name"
            
        elif [ "$type" = "new" ]; then
            echo "Initialising new repo: $name..."
            mkdir -p "/repos/$name"
            cd "/repos/$name"
            git init
            git checkout -b main
            
            # Create initial README
            echo "# $name" > README.md
            echo "" >> README.md
            echo "Created by Claude Session Manager" >> README.md
            git add README.md
            git commit -m "Initial commit"
            
            # Push to GitHub org if requested
            if [ -n "$GITHUB_ORG" ] && [ "$PUSH_TO_GITHUB" = "true" ] && [ -n "$GITHUB_TOKEN" ]; then
                echo "Creating GitHub repo ${GITHUB_ORG}/${name}..."
                RESPONSE=$(curl -s -X POST \
                    -H "Authorization: token $GITHUB_TOKEN" \
                    -H "Accept: application/vnd.github.v3+json" \
                    "https://api.github.com/orgs/${GITHUB_ORG}/repos" \
                    -d "{\"name\":\"${name}\",\"private\":true,\"auto_init\":false}")
                
                CLONE_URL=$(echo "$RESPONSE" | jq -r '.clone_url // empty')
                
                if [ -n "$CLONE_URL" ]; then
                    git remote add origin "$CLONE_URL"
                    git push -u origin main
                    echo "Pushed to $CLONE_URL"
                else
                    echo "WARNING: Could not create GitHub repo. Response: $RESPONSE"
                fi
            fi
        fi
    done
    echo "Repo setup complete."
fi

# ─── Determine working directory ─────────────────────────────────────────────
WORK_DIR="/repos"
REPO_COUNT=$(ls /repos 2>/dev/null | wc -l)

if [ "$REPO_COUNT" -eq 1 ]; then
    WORK_DIR="/repos/$(ls /repos | head -1)"
fi

# ─── Claude Code state setup ─────────────────────────────────────────────────
# Build ~/.claude.json with trust + auth state so Claude starts without prompts.
CLAUDE_STATE="/root/.claude.json"
echo '{"projects":{}, "hasCompletedOnboarding": true, "remoteDialogSeen": true}' > "$CLAUDE_STATE"

# If credentials were injected, extract auth info for the state file
CLAUDE_CREDS="/root/.claude/.credentials.json"
if [ -f "$CLAUDE_CREDS" ]; then
    echo "Found Claude credentials at $CLAUDE_CREDS"
    echo "Credentials file size: $(wc -c < "$CLAUDE_CREDS") bytes"
    SUBSCRIPTION=$(jq -r '.claudeAiOauth.subscriptionType // "unknown"' "$CLAUDE_CREDS")
    echo "Subscription type: $SUBSCRIPTION"
    tmp=$(mktemp)
    jq --arg sub "$SUBSCRIPTION" '.oauthAccount = {"subscriptionType": $sub}' "$CLAUDE_STATE" > "$tmp" && mv "$tmp" "$CLAUDE_STATE"
    echo "State file after auth setup:"
    cat "$CLAUDE_STATE"
else
    echo "WARNING: No Claude credentials found at $CLAUDE_CREDS"
    echo "Contents of /root/.claude/:"
    ls -la /root/.claude/ 2>/dev/null || echo "  (directory does not exist)"
fi

# Pre-trust working directories
trust_dir() {
    local dir="$1"
    local tmp=$(mktemp)
    jq --arg d "$dir" '.projects[$d] = {"hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true}' "$CLAUDE_STATE" > "$tmp" && mv "$tmp" "$CLAUDE_STATE"
}

trust_dir "/repos"
for d in /repos/*/; do
    [ -d "$d" ] && trust_dir "$(realpath "$d")"
done

# ─── Start tmux session with Claude Code ─────────────────────────────────────
TMUX_NAME="${TMUX_SESSION:-claude-main}"
CLAUDE_CMD="claude remote-control"
if [ -n "$SESSION_NAME" ]; then
    CLAUDE_CMD="$CLAUDE_CMD --name \"$SESSION_NAME\""
fi
if [ -n "$PERMISSION_MODE" ]; then
    CLAUDE_CMD="$CLAUDE_CMD --permission-mode $PERMISSION_MODE"
fi
# Default to same-dir spawn mode if not explicitly set
SPAWN_MODE="${SPAWN_MODE:-same-dir}"
CLAUDE_CMD="$CLAUDE_CMD --spawn=$SPAWN_MODE"

tmux new-session -d -s "$TMUX_NAME" -c "$WORK_DIR"

if [ "$REPO_COUNT" -gt 1 ]; then
    # Multiple repos — show a quick summary then start claude
    tmux send-keys -t "$TMUX_NAME" \
        "echo 'Repos available:' && ls /repos && echo '' && cd /repos && $CLAUDE_CMD" Enter
else
    tmux send-keys -t "$TMUX_NAME" "$CLAUDE_CMD" Enter
fi

echo "Session '$TMUX_NAME' started in $WORK_DIR"
echo "Claude command: $CLAUDE_CMD"
echo "Connect with: tmux attach -t $TMUX_NAME"

# Keep container alive — tail a log or just sleep loop
# sshd is already running as a daemon so we just wait
tail -f /dev/null
