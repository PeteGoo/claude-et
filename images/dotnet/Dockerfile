ARG BASE_TAG=latest
FROM ghcr.io/petegoo/claude-et-session-base:${BASE_TAG}

# .NET SDK 9
RUN apt-get update \
    && apt-get install -y dotnet-sdk-9.0 \
    && rm -rf /var/lib/apt/lists/*
