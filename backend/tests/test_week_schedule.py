"""Weekly occupancy of every room (Reservas view)."""
from datetime import date, datetime, time
from types import SimpleNamespace as NS

from app.services.week_schedule import build_week, monday_of

MONDAY = date(2026, 11, 2)


def cls(room, day, a, b, people=36):
    return NS(room_id=room, day_of_week=day, start_time=time(a), end_time=time(b), expected_people=people)


def res(room, start, end, people=20, user="profesor"):
    return NS(room_id=room, start_time=start, end_time=end, expected_occupancy=people, username=user)


def test_monday_of_any_day():
    assert monday_of(date(2026, 11, 5)) == MONDAY
    assert monday_of(MONDAY) == MONDAY


def test_classes_and_reservations_in_one_sorted_list():
    blocks = build_week(
        [cls("M601", 1, 16, 18), cls("M802", 1, 9, 11)],
        [res("M802", datetime(2026, 11, 4, 9), datetime(2026, 11, 4, 11))],
        MONDAY, show_users=True,
    )
    assert [(b["room_id"], b["day"], b["start"], b["kind"]) for b in blocks] == [
        ("M802", 1, "09:00", "class"), ("M601", 1, "16:00", "class"), ("M802", 2, "09:00", "reservation"),
    ]
    assert blocks[2]["by"] == "profesor" and blocks[2]["people"] == 20


def test_reservations_outside_the_week_are_ignored():
    blocks = build_week([], [res("A403", datetime(2026, 11, 9, 8), datetime(2026, 11, 9, 10))], MONDAY, show_users=True)
    assert blocks == []


def test_guests_do_not_see_who_reserved():
    blocks = build_week([], [res("A403", datetime(2026, 11, 3, 8), datetime(2026, 11, 3, 10))], MONDAY, show_users=False)
    assert blocks[0]["by"] is None


def test_reservation_past_midnight_is_cut_at_end_of_day():
    blocks = build_week([], [res("A403", datetime(2026, 11, 3, 22), datetime(2026, 11, 4, 1))], MONDAY, show_users=True)
    assert (blocks[0]["day"], blocks[0]["start"], blocks[0]["end"]) == (1, "22:00", "23:59")
