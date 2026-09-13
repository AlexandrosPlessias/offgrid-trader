"""Route package — re-exports all APIRouter instances."""
from backend.routes.health import router as health_router
from backend.routes.watchlist import router as watchlist_router
from backend.routes.settings import router as settings_router
from backend.routes.alpaca import router as alpaca_router
from backend.routes.analysis import router as analysis_router
from backend.routes.data import router as data_router
from backend.routes.discovery import router as discovery_router
from backend.routes.usage import router as usage_router
from backend.routes.backtest import router as backtest_router

all_routers = [
    health_router,
    watchlist_router,
    settings_router,
    alpaca_router,
    analysis_router,
    data_router,
    discovery_router,
    usage_router,
    backtest_router,
]

__all__ = [
    "health_router",
    "watchlist_router",
    "settings_router",
    "alpaca_router",
    "analysis_router",
    "data_router",
    "discovery_router",
    "usage_router",
    "backtest_router",
    "all_routers",
]
