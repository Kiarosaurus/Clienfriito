"""
Shared bootstrap-label helpers for the ML pipeline.

Single home for the occupancy heuristic used BOTH to build the synthetic
target (extract_data.py) and as the baseline the model must beat
(train_model.py). They must stay numerically identical — if they drift,
`beats_baselines` loses its meaning.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
from app.services.predictive_service import THERMAL_LOAD_PER_PERSON  # noqa: E402


def hour_weight(hours) -> np.ndarray:
    """Diurnal occupancy-load weight: peaks mid-afternoon (~14 h), trough ~02 h."""
    return 1 + 0.3 * np.sin((np.asarray(hours) - 8) * np.pi / 12)


def bootstrap_people_load(actual_occupancy, hours) -> np.ndarray:
    """Occupancy term of the bootstrap label: people × thermal load × hour weight."""
    return np.asarray(actual_occupancy) * THERMAL_LOAD_PER_PERSON * hour_weight(hours)
