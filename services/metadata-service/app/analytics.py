"""Pure helpers for user-scoped analytics responses."""

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Iterable


FILE_TYPE_BUCKETS = (
    ("Images", "#3b82f6"),
    ("Videos", "#ec4899"),
    ("Documents", "#10b981"),
    ("Archives", "#f59e0b"),
    ("Others", "#6b7280"),
)


def classify_mime_type(mime_type: str | None) -> str:
    value = (mime_type or "").lower()
    if value.startswith("image/"):
        return "Images"
    if value.startswith("video/"):
        return "Videos"
    if value.startswith("text/") or value in {
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }:
        return "Documents"
    if value in {
        "application/zip",
        "application/x-7z-compressed",
        "application/x-rar-compressed",
        "application/gzip",
        "application/x-tar",
    }:
        return "Archives"
    return "Others"


def summarize_file_types(rows: Iterable[tuple[str | None, int]]) -> list[dict]:
    counts = defaultdict(int)
    for mime_type, count in rows:
        counts[classify_mime_type(mime_type)] += int(count or 0)
    return [
        {"name": name, "value": counts[name], "color": color}
        for name, color in FILE_TYPE_BUCKETS
        if counts[name] > 0
    ]


def _coerce_hour(value: datetime | str) -> datetime:
    if isinstance(value, datetime):
        return value.replace(minute=0, second=0, microsecond=0)
    return datetime.fromisoformat(str(value)).replace(minute=0, second=0, microsecond=0)


def build_upload_activity(
    hourly_rows: Iterable[tuple[datetime | str, int]],
    now: datetime,
) -> list[dict]:
    end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    start = end - timedelta(hours=24)
    buckets = [0] * 6
    for hour_value, count in hourly_rows:
        hour = _coerce_hour(hour_value)
        if start <= hour < end:
            index = min(5, int((hour - start).total_seconds() // (4 * 3600)))
            buckets[index] += int(count or 0)
    return [
        {
            "time": (start + timedelta(hours=index * 4)).strftime("%H:%M"),
            "uploads": count,
        }
        for index, count in enumerate(buckets)
    ]


def build_storage_growth(
    current_bytes: int,
    daily_rows: Iterable[tuple[date | str, int]],
    today: date,
    days: int = 7,
) -> list[dict]:
    daily = {
        value if isinstance(value, date) else date.fromisoformat(str(value)): int(size or 0)
        for value, size in daily_rows
    }
    dates = [today - timedelta(days=offset) for offset in reversed(range(days))]
    bytes_after_day = 0
    result = []
    for day in reversed(dates):
        result.append({
            "day": day.strftime("%a"),
            "date": day.isoformat(),
            "storage_bytes": max(0, int(current_bytes or 0) - bytes_after_day),
        })
        bytes_after_day += daily.get(day, 0)
    return list(reversed(result))
