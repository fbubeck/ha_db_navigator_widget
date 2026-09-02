"""DB Navigator Widgets integration.

This integration does not fetch journey data itself. It only exposes the bundled
Lovelace card, which reads entities created by an existing DB Info integration.
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

try:
    from homeassistant.components.http import StaticPathConfig
except ImportError:  # pragma: no cover - compatibility with older HA releases
    try:
        from homeassistant.components.http.static import StaticPathConfig
    except ImportError:  # pragma: no cover
        StaticPathConfig = None

from .const import DOMAIN, STATIC_URL_PATH

_LOGGER = logging.getLogger(__name__)
_STATIC_DIR = Path(__file__).parent / "www"
_REGISTERED_KEY = f"{DOMAIN}_frontend_registered"


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Expose the bundled Lovelace card as a cacheable static asset."""
    if hass.data.get(_REGISTERED_KEY):
        return

    if hasattr(hass.http, "async_register_static_paths") and StaticPathConfig:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL_PATH, str(_STATIC_DIR), False)]
        )
    elif hasattr(hass.http, "register_static_path"):
        hass.http.register_static_path(STATIC_URL_PATH, str(_STATIC_DIR), False)
    else:  # pragma: no cover - defensive guard for unsupported HA versions
        _LOGGER.error("This Home Assistant version cannot expose the DB Navigator card")
        return

    hass.data[_REGISTERED_KEY] = True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up DB Navigator Widgets from a config entry."""
    await _async_register_frontend(hass)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = entry
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry.

    Home Assistant cannot unregister a static path at runtime. The path disappears
    on the next restart after the integration has been removed.
    """
    entries = hass.data.get(DOMAIN)
    if entries is not None:
        entries.pop(entry.entry_id, None)
    return True
