FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Core system packages
RUN apt-get update && apt-get install -y \
    openssh-server \
    tmux \
    git \
    curl \
    wget \
    vim \
    nano \
    jq \
    ca-certificates \
    gnupg \
    lsb-release \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

# SSH setup
RUN mkdir /var/run/sshd && \
    mkdir -p /root/.ssh && \
    chmod 700 /root/.ssh

# Disable password auth, enable key auth
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    echo "PermitRootLogin yes" >> /etc/ssh/sshd_config

# Git credential helper script — uses injected GITHUB_TOKEN
RUN echo '#!/bin/bash\necho "password=$GITHUB_TOKEN"' > /usr/local/bin/git-credential-github && \
    chmod +x /usr/local/bin/git-credential-github

# Working directory for repos
RUN mkdir -p /repos
WORKDIR /repos

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22

ENTRYPOINT ["/entrypoint.sh"]
