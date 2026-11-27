
FROM debian:bookworm-slim
ARG TARGETARCH
ARG VSEMKOD_RELEASE=latest
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac; \
    asset="vsemkod-cli-linux-$arch"; \
    repo=https://github.com/danielleonov1488-ship-it/vsemkod/releases; \
    if [ "$VSEMKOD_RELEASE" = latest ]; then url="$repo/latest/download"; else url="$repo/download/$VSEMKOD_RELEASE"; fi; \
    cd /tmp; \
    curl -fsSLO "$url/$asset"; \
    curl -fsSLO "$url/vsemkod-cli-checksums.txt"; \
    awk -v file="$asset" '$2 == file {print; count++} END {if (count != 1) exit 1}' vsemkod-cli-checksums.txt > asset.sha256; \
    sha256sum -c asset.sha256; \
    install -m 755 "$asset" /usr/local/bin/vsemkod; \
    rm -f "$asset" asset.sha256 vsemkod-cli-checksums.txt
RUN useradd --create-home --uid 10001 vsemkod && install -d -o vsemkod /work
USER vsemkod
WORKDIR /work
ENTRYPOINT ["vsemkod"]
CMD ["help"]
