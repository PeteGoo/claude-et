ARG BASE_TAG=latest
FROM ghcr.io/petegoo/claude-et-session-base:${BASE_TAG}

# .NET SDK 9
ENV DOTNET_ROOT=/usr/share/dotnet
ENV PATH="${PATH}:${DOTNET_ROOT}:${DOTNET_ROOT}/tools"
RUN wget https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh \
    && chmod +x /tmp/dotnet-install.sh \
    && /tmp/dotnet-install.sh --channel 9.0 --install-dir "${DOTNET_ROOT}" \
    && rm /tmp/dotnet-install.sh \
    && ln -s "${DOTNET_ROOT}/dotnet" /usr/bin/dotnet
