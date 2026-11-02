from app.services.node_emulator import co2_to_adc, emulate

OCCUPIED = 1350   # ppm, above the firmware's 2200 ADC threshold


def test_adc_mapping_matches_firmware():
    assert co2_to_adc(400) == 0
    assert co2_to_adc(2000) == 4095
    # The dashboard shows the empty-room threshold as 1260 ppm (= ADC 2200).
    assert co2_to_adc(1250) < 2200 <= co2_to_adc(1260)


def test_empty_room_turns_everything_off():
    s = emulate(26.0, 450, 1)
    assert s["accion"] == "DISABLED" and s["ventilador_pwm"] == 0 and not s["calefactor"]


def test_temperature_bands():
    assert emulate(22.5, OCCUPIED, 1)["calefactor"] is True
    assert emulate(24.0, OCCUPIED, 1)["accion"] == "STANDBY"
    assert emulate(24.8, OCCUPIED, 1)["ventilador_pwm"] == 128
    assert emulate(25.2, OCCUPIED, 1)["ventilador_pwm"] == 191
    assert emulate(25.8, OCCUPIED, 1)["ventilador_pwm"] == 255


def test_high_co2_runs_the_fan_at_full():
    s = emulate(24.2, 1650, 1)
    assert s["ventilador_pwm"] == 255 and s["led"] == "AZUL"


def test_co_alarm_wins_over_everything():
    s = emulate(22.0, 450, 80)
    assert s["alarma_co"] and s["buzzer"] and s["ventilador_pwm"] == 255 and not s["calefactor"]
    assert s["led"] == "ROJO"
