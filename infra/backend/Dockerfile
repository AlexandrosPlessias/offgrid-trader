# offgrid-trader backend image.
# Single FastAPI service; the LLM runs in the separate `ollama` container.
FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements/backend.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application package and tests.
COPY backend/ backend/
COPY tests/ tests/

# Data dir for the SQLite database (mounted as a volume in compose).
RUN mkdir -p /app/data

# ntfy binary — lightweight push-notification server (used as a Fly.io sidecar).
# Download is architecture-aware; ARM64 for Apple Silicon VMs, amd64 otherwise.
RUN ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') && \
    curl -fsSL \
      "https://github.com/binwiederhier/ntfy/releases/latest/download/ntfy_linux_${ARCH}.tar.gz" \
      | tar xz --strip-components=1 -C /usr/local/bin "ntfy_linux_${ARCH}/ntfy" && \
    chmod +x /usr/local/bin/ntfy

COPY infra/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/app/data/offgrid_trader.db

EXPOSE 8000 18880

CMD ["/entrypoint.sh"]
