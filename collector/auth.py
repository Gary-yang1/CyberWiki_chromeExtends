"""Per-user API-key gate for the collector server.

The user list lives in data/collector_auth.json:

    { "users": { "gary": "key-gary-xxxx", "alice": "key-alice-yyyy" } }

When the file is missing or defines no users, the server runs in open mode
with a single shared "default" space. As soon as at least one user exists,
every /api/v1 request must carry matching X-User-Id and X-Api-Key headers,
and all extraction data is partitioned per user id.
"""

from __future__ import annotations

import hmac
import json
import re
from pathlib import Path

from .service import CollectorError, USER_ID_PATTERN

DEFAULT_USER = "default"


def load_users(path: Path) -> dict[str, str]:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    users = raw.get("users") if isinstance(raw, dict) else None
    if not isinstance(users, dict):
        return {}
    return {
        str(user_id).strip(): str(key).strip()
        for user_id, key in users.items()
        if str(user_id).strip() and str(key).strip()
    }


def resolve_user(users: dict[str, str], user_id, api_key) -> str:
    """Return the storage scope for this request.

    Raises CollectorError(401) when the gate is active and the credentials
    are absent or wrong; returns DEFAULT_USER in open mode.
    """
    if not users:
        return DEFAULT_USER

    candidate = str(user_id or "").strip()
    key = str(api_key or "").strip()
    if not USER_ID_PATTERN.match(candidate):
        raise CollectorError(
            401,
            "unauthorized",
            "用户 ID 无效（仅限 1–32 位字母、数字、下划线、连字符）。",
        )
    if not key:
        raise CollectorError(401, "unauthorized", "缺少 X-Api-Key。")
    expected = users.get(candidate)
    if not expected or not hmac.compare_digest(expected, key):
        raise CollectorError(401, "unauthorized", "用户 ID 或 Key 不正确。")
    return candidate
