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

ENV PYTHONUNBUFFERED=1 \
    DATABASE_PATH=/app/data/offgrid_trader.db

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
