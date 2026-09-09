"""FastAPI application exposing the offgrid-trader backend.

Endpoints are implemented in ``backend/routes/``; this module only wires
up the application: lifespan, middleware, and ``include_router`` calls.

Run::

    uvicorn backend.main:app --reload
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

from . import __version__
from .config import get_settings
from .database import get_setting, init_db
from .scheduler import scheduler
from .routes import all_routers

_log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# OpenTelemetry (optional — only active when OTEL_EXPORTER_OTLP_ENDPOINT set)
# --------------------------------------------------------------------------- #
def _setup_otel(app: FastAPI) -> None:
    """Wire OpenTelemetry traces, metrics, and logs to Aspire dashboard."""
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")
    if not endpoint:
        return
    try:
        from opentelemetry import metrics, trace
        from opentelemetry._logs import set_logger_provider
        from opentelemetry.exporter.otlp.proto.grpc._log_exporter import (
            OTLPLogExporter,
        )
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.requests import RequestsInstrumentor
        from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
        from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        resource = Resource({SERVICE_NAME: "offgrid-trader"})

        tracer = TracerProvider(resource=resource)
        tracer.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
        trace.set_tracer_provider(tracer)

        metrics.set_meter_provider(
            MeterProvider(
                resource=resource,
                metric_readers=[
                    PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=endpoint))
                ],
            )
        )

        log_provider = LoggerProvider(resource=resource)
        log_provider.add_log_record_processor(
            BatchLogRecordProcessor(OTLPLogExporter(endpoint=endpoint))
        )
        set_logger_provider(log_provider)
        logging.getLogger().addHandler(
            LoggingHandler(level=logging.INFO, logger_provider=log_provider)
        )

        logging.getLogger().setLevel(logging.INFO)

        FastAPIInstrumentor.instrument_app(app, excluded_urls="health")
        RequestsInstrumentor().instrument()
        logging.getLogger(__name__).info("telemetry → %s", endpoint)
    except ImportError:
        print("[otel] opentelemetry packages missing — skipping telemetry")


# --------------------------------------------------------------------------- #
# App + lifespan
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise the DB and start/stop the background scheduler.

    Auto-scan is OFF by default.  It starts only when the DB setting
    ``scheduler_running`` is explicitly ``"true"`` (set via the Settings page
    or ``POST /settings/scheduler``).  This prevents unexpected background
    scans on fresh installs and after container restarts.
    """
    init_db()
    # Start the scheduler if the DB setting says "true" (user has toggled it
    # at runtime), or if no DB override exists yet and SCHEDULER_AUTO_START=true
    # is set in .env (fresh install default).
    db_sched = get_setting("scheduler_running", "")
    env_auto = get_settings().scheduler_auto_start
    if db_sched == "true" or (db_sched == "" and env_auto):
        scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()


app = FastAPI(
    title="offgrid-trader",
    version=__version__,
    description="Local, zero-cost AI stock monitor. Not financial advice.",
    lifespan=lifespan,
)
_setup_otel(app)

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------- #
# Admin token middleware — gates all routes when ADMIN_TOKEN is configured.
# /health and /auth/verify are always open (health probe + login endpoint).
# When ADMIN_TOKEN is not set the middleware is a no-op (local / dev mode).
# --------------------------------------------------------------------------- #
_UNPROTECTED_PATHS = {"/health", "/auth/verify"}


class _AdminTokenMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):  # type: ignore[override]
        if request.method == "OPTIONS" or request.url.path in _UNPROTECTED_PATHS:
            return await call_next(request)
        expected = get_settings().admin_token or get_setting("admin_token", "")
        if not expected:
            return await call_next(request)  # dev mode: no token configured → open
        auth_header = request.headers.get("Authorization", "")
        token = auth_header.removeprefix("Bearer ").strip()
        if token != expected:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)


app.add_middleware(_AdminTokenMiddleware)

# --------------------------------------------------------------------------- #
# Mount all routers
# --------------------------------------------------------------------------- #
for _router in all_routers:
    app.include_router(_router)
