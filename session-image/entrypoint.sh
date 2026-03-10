#!/bin/bash
set -e

# ─── Git credential setup ────────────────────────────────────────────────────
# This lets 'git push' work using the GitHub token without any interactive auth
if [ -n "$GITHUB_TOKEN" ]; then
    git config --global credential.helper store
    git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
    git config --global user.email "${GIT_EMAIL:-claude-session@localhost}"
    git config --global user.name "${GIT_NAME:-Claude Session}"
fi

# ─── SSH: install authorized key if provided ─────────────────────────────────
if [ -n "$SSH_PUBLIC_KEY" ]; then
    echo "$SSH_PUBLIC_KEY" >> /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
fi

# Start SSH daemon
/usr/sbin/sshd

# ─── Repo setup ──────────────────────────────────────────────────────────────
# SESSION_REPOS format: "name:url:type,name::new"
# type = "clone" | "new"
# For new repos, url is empty

if [ -n "$SESSION_REPOS" ]; then
    echo "Setting up repos..."
    IFS=',' read -ra REPO_ENTRIES <<< "$SESSION_REPOS"
    
    for entry in "${REPO_ENTRIES[@]}"; do
        IFS=':' read -r name url type <<< "$entry"
        
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

# ─── Start tmux session with Claude Code ─────────────────────────────────────
SESSION_NAME="${TMUX_SESSION:-claude-main}"

tmux new-session -d -s "$SESSION_NAME" -c "$WORK_DIR"

if [ "$REPO_COUNT" -gt 1 ]; then
    # Multiple repos — show a quick summary then start claude
    tmux send-keys -t "$SESSION_NAME" \
        "echo 'Repos available:' && ls /repos && echo '' && cd /repos && claude" Enter
else
    tmux send-keys -t "$SESSION_NAME" "claude" Enter
fi

echo "Session '$SESSION_NAME' started in $WORK_DIR"
echo "Connect with: tmux attach -t $SESSION_NAME"

# Keep container alive — tail a log or just sleep loop
# sshd is already running as a daemon so we just wait
tail -f /dev/null
