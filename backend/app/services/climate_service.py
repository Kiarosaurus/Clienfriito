"""
Climate service — deterministic outdoor-temperature model for Lima, Perú.

Provides the EXOGENOUS driver the thermal model was missing: the outside air
temperature. It is computed analytically from month + hour (a seasonal mean plus
a diurnal cosine), so it needs no hardware, no weather API, and is fully
reproducible — the same timestamp always yields the same outdoor temperature.

Why it matters: without an exogenous driver, the cooling-demand label degenerates
into `occupancy × k`, which the occupancy heuristic already reproduces exactly, so
an ML model can never beat that baseline. Feeding the outdoor temperature gives the
model real, independent signal to learn (see TECHNICAL_DOCUMENTATION.md §3.9 / Tier 2).

Both the seed generator and the live predictive service import THIS module, so the
climate assumption is defined in exactly one place.
"""
import math
from datetime import datetime

# Lima monthly mean outdoor temperature (°C). Coastal desert: mild, low range,
# overcast winters (May–Sep, the "garúa" season) and warm humid summers.
_MONTHLY_MEAN_C = {
    1: 23.0, 2: 24.0, 3: 23.5, 4: 21.5, 5: 19.5, 6: 18.0,
    7: 17.0, 8: 17.0, 9: 17.5, 10: 18.5, 11: 20.0, 12: 22.0,
}

# Diurnal swing amplitude (°C, peak-to-mean). Lima's ocean keeps it small.
_DIURNAL_AMPLITUDE_C = 3.0

# Hour of the daily temperature peak (local solar warming lags noon).
_PEAK_HOUR = 14.0


def outdoor_temp(ts: datetime) -> float:
    """Return the modeled outdoor temperature in °C for a given timestamp.

    seasonal_mean(month) + amplitude · cos(2π · (hour − peak) / 24)
    """
    mean = _MONTHLY_MEAN_C.get(ts.month, 20.0)
    # Fractional hour so 10-min ticks vary smoothly, not in 1-hour steps.
    hour = ts.hour + ts.minute / 60.0
    diurnal = _DIURNAL_AMPLITUDE_C * math.cos(2 * math.pi * (hour - _PEAK_HOUR) / 24.0)
    return round(mean + diurnal, 2)
