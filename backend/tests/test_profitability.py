from app.services.profitability import reference_kwh, strategy_kwh

STEP = 1800  # half an hour per row keeps the arithmetic readable


def row(occupied=False, temperature=25.0, fan=0.0, heat=0.0):
    return {"occupied": occupied, "temperature": temperature, "fan": fan, "heat": heat}


def test_strategy_kwh_uses_fan_cube_and_heater_duty():
    rows = [row(fan=0.5), row(heat=1.0)]
    # fan: 180 W · 0.125 · 0.5 h = 11.25 Wh; heater: 2000 W · 0.5 h = 1000 Wh
    assert abs(strategy_kwh(rows, STEP, 180, 2000) - 1.01125) < 1e-9


def test_reference_runs_extractor_for_a_warm_class():
    rows = [row(), row(occupied=True), row(occupied=True), row()]
    kwh, hours = reference_kwh(rows, STEP, 180, 2000)
    assert hours == 1.0
    assert abs(kwh - 0.18) < 1e-9


def test_reference_runs_heater_when_class_starts_cold():
    # Only the temperature at the start of the class decides the equipment.
    rows = [row(occupied=True, temperature=20.0), row(occupied=True, temperature=26.0)]
    kwh, hours = reference_kwh(rows, STEP, 180, 2000)
    assert hours == 1.0
    assert abs(kwh - 2.0) < 1e-9


def test_reference_counts_each_class_apart():
    rows = [row(occupied=True, temperature=20.0), row(), row(occupied=True)]
    kwh, hours = reference_kwh(rows, STEP, 180, 2000)
    assert hours == 1.0
    assert abs(kwh - (1.0 + 0.09)) < 1e-9


def test_empty_simulation_gives_zero():
    assert reference_kwh([], STEP, 180, 2000) == (0.0, 0.0)
    assert strategy_kwh([], STEP, 180, 2000) == 0.0
