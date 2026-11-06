"""Canonical timestamp handling for the API.

The API and worker containers run on a UTC clock, while the operators who read
this UI are in Asia/Shanghai. Any bare ``datetime.now()`` therefore stamps
records with UTC wall-clock digits that get printed verbatim, which is how
publish times ended up eight hours behind the timestamps shown on the
platforms themselves.

Two rules keep that from happening again:

* Everything persisted or transported is an ISO 8601 string carrying an
  explicit UTC offset, so it can never be re-read in the wrong zone.
* Wall-clock-only values are resolved against the display timezone or, when
  they predate this module, recognised as the UTC they were written in.

Naive stamps are read as UTC on purpose: it matches ``workflow_records._timestamp``
and it is what the old ``datetime.now()`` calls actually produced.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

try:  # pragma: no cover - depends on the container image shipping tzdata
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]


DISPLAY_TIMEZONE_NAME = "Asia/Shanghai"

# China stopped observing daylight saving in 1991, so a fixed offset is an exact
# stand-in whenever the IANA database is unavailable.
FALLBACK_DISPLAY_TIMEZONE = timezone(timedelta(hours=8))

_LEGACY_FORMAT = "%m/%d %H:%M"
_LEGACY_STAMP = re.compile(r"^\d{1,2}/\d{1,2} \d{1,2}:\d{2}$")


def _load_display_timezone() -> Any:
    if ZoneInfo is None:
        return FALLBACK_DISPLAY_TIMEZONE
    try:
        return ZoneInfo(DISPLAY_TIMEZONE_NAME)
    except Exception:  # pragma: no cover - missing tzdata, bad install
        return FALLBACK_DISPLAY_TIMEZONE


_DISPLAY_TIMEZONE = _load_display_timezone()


def display_timezone() -> Any:
    """Timezone all human-facing timestamps are rendered in."""
    return _DISPLAY_TIMEZONE


def now() -> datetime:
    """Current moment as a timezone-aware datetime."""
    return datetime.now(_DISPLAY_TIMEZONE)


def now_stamp() -> str:
    """Current moment as an ISO 8601 string with an explicit offset."""
    return now().isoformat(timespec="seconds")


def today_key() -> str:
    """Calendar day in the display timezone, not in the container's UTC."""
    return now().strftime("%Y-%m-%d")


def parse_stored_timestamp(value: Any, current: datetime | None = None) -> datetime | None:
    """Parse a persisted timestamp without trusting the process timezone.

    Accepts ISO 8601 with or without an offset, the legacy ``MM/DD HH:MM``
    label, and returns ``None`` for anything unrecognised. Naive values are
    treated as UTC because that is what the previous ``datetime.now()`` calls
    wrote on this deployment.
    """
    text = str(value or "").strip()
    if not text:
        return None

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        parsed = None

    if parsed is not None:
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc).astimezone(_DISPLAY_TIMEZONE)
        return parsed

    if not _LEGACY_STAMP.match(text):
        return None

    reference = (current or now()).astimezone(_DISPLAY_TIMEZONE)
    parsed = datetime.strptime(text, _LEGACY_FORMAT)
    for year in (reference.year, reference.year - 1):
        # A legacy label carries no year, so keep the reading that is closest
        # to "now" instead of letting a December record jump into the future.
        candidate = parsed.replace(year=year, tzinfo=timezone.utc).astimezone(_DISPLAY_TIMEZONE)
        if candidate <= reference + timedelta(days=1):
            return candidate
    return parsed.replace(year=reference.year - 1, tzinfo=timezone.utc).astimezone(_DISPLAY_TIMEZONE)


def sortable_timestamp(value: Any) -> datetime:
    """Total-order sort key for records, tolerant of legacy and junk stamps.

    Ordering must not depend on which offset a stamp happens to carry: a UTC
    stamp and a Beijing stamp for the same instant are different strings, so
    comparing the text directly silently misorders records that straddle the
    eight-hour gap. Records without a readable stamp sort oldest.
    """
    return parse_stored_timestamp(value) or datetime.min.replace(tzinfo=timezone.utc)


def normalize_timestamps(value: Any) -> Any:
    """Rewrite stored timestamps into offset-carrying ISO 8601 strings.

    Applied as records leave the database so every downstream consumer (UI
    rendering, sorting, staleness comparisons) works from one representation.
    Only strings that look like timestamps are touched, so ordinary payload
    fields pass through untouched and by reference.

    Text UTF-8 cannot encode is repaired here as well. A platform page read
    with a mangled charset hands back a string whose emoji was cut in half;
    Python's JSON parser accepts the lone escape without complaint and a
    ``json`` column stores it verbatim, but encoding the record back out
    raises ``UnicodeEncodeError``. One such string was enough to turn every
    endpoint returning that collection into a 500 and strand every queued
    command for every device. Repairing instead of dropping keeps the record
    readable, and doing it here rather than inside one endpoint is what also
    covers the single-fetch path.

    The repair is deliberately silent. The agent polls every few seconds, so a
    line per repaired record per poll would drown everything else out. Damage
    that arrives through ``save_record`` is logged where it is caught; a
    repair firing here means something reached the database past that guard.
    """
    if isinstance(value, dict):
        return {
            sanitize_unencodable_text(key): normalize_timestamps(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [normalize_timestamps(item) for item in value]
    if isinstance(value, str) and _is_rewritable_timestamp(value):
        return parse_stored_timestamp(value).isoformat(timespec="seconds")
    return sanitize_unencodable_text(value)


LONE_SURROGATE_PATTERN = re.compile("[\ud800-\udfff]")
REPLACEMENT_CHARACTER = "\ufffd"


def sanitize_unencodable_text(value: Any) -> Any:
    """Replace UTF-16 surrogates that UTF-8 cannot encode with U+FFFD.

    Python holds a real emoji as a single code point outside the surrogate
    range, because ``json.loads`` combines a well-formed pair before we ever
    see it. Anything left inside the range is therefore half of a character
    with no partner, and no encoder can write it out. The ``isascii`` gate
    keeps the common case -- ids, stamps, urls, statuses -- down to one
    C-level scan.
    """
    if isinstance(value, str):
        if value.isascii() or not LONE_SURROGATE_PATTERN.search(value):
            return value
        return LONE_SURROGATE_PATTERN.sub(REPLACEMENT_CHARACTER, value)
    if isinstance(value, dict):
        return {
            sanitize_unencodable_text(key): sanitize_unencodable_text(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [sanitize_unencodable_text(item) for item in value]
    if isinstance(value, tuple):
        return tuple(sanitize_unencodable_text(item) for item in value)
    return value


def _is_rewritable_timestamp(text: str) -> bool:
    if _LEGACY_STAMP.match(text):
        return True
    if not re.match(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", text):
        return False
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is None
