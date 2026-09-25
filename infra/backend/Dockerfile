# offgrid-trader backend image.
# Single FastAPI service; the LLM runs in the separate `ollama` container.
# ntfy push-notification server runs as a sidecar (see infra/entrypoint.sh).
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

# ntfy binary — copied from the official multi-arch image (no download needed).
# Pin the version here; Docker resolves the correct architecture automatically.
COPY --from=binwiederhier/ntfy:v2.28.0 /usr/bin/ntfy /usr/local/bin/ntfy

COPY infra/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ARG BUILD_SHA=""
ARG BUILD_SOURCE=""
ENV PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/app/data/offgrid_trader.db \
    BUILD_SHA=$BUILD_SHA \
    BUILD_SOURCE=$BUILD_SOURCE

EXPOSE 8000 18880

CMD ["/entrypoint.sh"]
