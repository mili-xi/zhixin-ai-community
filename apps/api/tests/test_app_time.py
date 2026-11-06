from datetime import datetime, timedelta, timezone

from app import app_time


BEIJING = timezone(timedelta(hours=8))


def test_now_stamp_carries_an_explicit_offset():
    parsed = datetime.fromisoformat(app_time.now_stamp())
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == timedelta(hours=8)


def test_today_key_uses_the_display_calendar_day():
    # A moment just after midnight UTC is still the previous Beijing day, and
    # that is the day the operators count work against.
    late_utc = datetime(2026, 7, 27, 16, 30, tzinfo=timezone.utc)
    assert late_utc.astimezone(BEIJING).strftime("%Y-%m-%d") == "2026-07-28"
    assert app_time.today_key()


def test_legacy_label_is_read_as_utc_wall_clock():
    # "07/27 14:47" is what the old bare datetime.now() wrote on the UTC
    # container, so it denotes 22:47 in Beijing, not 14:47.
    parsed = app_time.parse_stored_timestamp("07/27 14:47")
    assert parsed == datetime(2026, 7, 27, 22, 47, tzinfo=BEIJING)


def test_legacy_label_resolves_the_year_toward_the_reference_moment():
    late_december = datetime(2027, 1, 5, 10, 0, tzinfo=BEIJING)
    parsed = app_time.parse_stored_timestamp("12/31 20:00", current=late_december)
    assert parsed == datetime(2026, 12, 31, 20, 0, tzinfo=timezone.utc).astimezone(BEIJING)

    early_january = datetime(2026, 1, 5, 10, 0, tzinfo=BEIJING)
    assert app_time.parse_stored_timestamp("01/05 02:00", current=early_january) == datetime(
        2026, 1, 5, 2, 0, tzinfo=timezone.utc
    ).astimezone(BEIJING)


def test_naive_iso_is_read_as_utc():
    parsed = app_time.parse_stored_timestamp("2026-10-04 08:11:36")
    assert parsed == datetime(2026, 10, 4, 16, 11, 36, tzinfo=BEIJING)


def test_offset_bearing_iso_is_preserved_verbatim():
    for value in ("2026-10-04T16:11:36+08:00", "2026-10-04T08:11:36Z"):
        parsed = app_time.parse_stored_timestamp(value)
        assert datetime.fromisoformat(value.replace("Z", "+00:00")) == parsed


def test_unrecognised_values_return_none():
    for value in ("", "   ", "abc", "not-a-time", None, 0):
        assert app_time.parse_stored_timestamp(value) is None


def test_normalize_timestamps_upgrades_legacy_and_naive_values_only():
    payload = {
        "updatedAt": "07/27 14:47",
        "createdAt": "2026-10-04 08:11:36",
        "verifiedAt": "2026-10-04T08:11:36Z",
        "title": "not a timestamp",
        "count": 5,
        "nothing": None,
        "nested": [{"publishedAt": "07/28 09:05"}, {"unparseable": "07/27"}],
    }
    normalized = app_time.normalize_timestamps(payload)

    assert normalized["updatedAt"] == "2026-07-27T22:47:00+08:00"
    assert normalized["createdAt"] == "2026-10-04T16:11:36+08:00"
    assert normalized["verifiedAt"] == "2026-10-04T08:11:36Z"
    assert normalized["title"] == "not a timestamp"
    assert normalized["count"] == 5
    assert normalized["nothing"] is None
    assert normalized["nested"][0]["publishedAt"] == "2026-07-28T17:05:00+08:00"
    assert normalized["nested"][1]["unparseable"] == "07/27"


def test_normalize_timestamps_does_not_mutate_the_input():
    payload = {"updatedAt": "07/27 14:47", "nested": {"checkedAt": "07/27 14:47"}}
    app_time.normalize_timestamps(payload)
    assert payload == {"updatedAt": "07/27 14:47", "nested": {"checkedAt": "07/27 14:47"}}


def test_sortable_timestamp_orders_by_instant_rather_than_by_offset_text():
    # "01:00Z" is 09:00 in Beijing and therefore newer than "08:00+08:00",
    # yet the plain text reads the other way round.
    beijing_earlier = "2026-07-27T08:00:00+08:00"
    utc_later = "2026-07-27T01:00:00Z"
    assert utc_later < beijing_earlier
    assert app_time.sortable_timestamp(utc_later) > app_time.sortable_timestamp(beijing_earlier)


def test_sortable_timestamp_orders_legacy_labels_against_each_other():
    assert app_time.sortable_timestamp("07/27 15:47") > app_time.sortable_timestamp("07/27 14:47")


def test_sortable_timestamp_places_unreadable_stamps_oldest():
    oldest = datetime.min.replace(tzinfo=timezone.utc)
    assert app_time.sortable_timestamp("") == oldest
    assert app_time.sortable_timestamp(None) == oldest
    assert app_time.sortable_timestamp("not-a-time") == oldest
    assert app_time.sortable_timestamp("") < app_time.sortable_timestamp("2026-07-27T00:00:00Z")
