"""Question-collection storage: one JSON file per page extraction."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class CollectorError(ValueError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# <UTC stamp>Z-<content hash 8>[-<collision counter>]
ID_PATTERN = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{8}(-\d+)?$")
MAX_QUESTIONS_PER_EXTRACTION = 500
# Storage scopes are one directory name per user; keep them traversal-safe.
USER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def user_out_dir(base_dir: Path, user_id: str) -> Path:
    """Resolve the per-user extraction directory, rejecting unsafe ids."""
    candidate = str(user_id or "").strip()
    if not USER_ID_PATTERN.match(candidate):
        raise CollectorError(
            400, "invalid_user_id", "用户 ID 无效（仅限 1–32 位字母、数字、下划线、连字符）。"
        )
    return Path(base_dir) / candidate


def _normalize_question(question: Any) -> dict[str, Any]:
    if not isinstance(question, dict):
        raise CollectorError(400, "invalid_question", "每道题必须是 JSON 对象。")
    stem = question.get("stem")
    if not isinstance(stem, str) or not stem.strip():
        raise CollectorError(400, "invalid_question", "每道题必须包含非空的 stem 字段。")
    normalized = dict(question)
    normalized["stem"] = stem.strip()
    # The AI solver fills this slot later; keep it present and stable.
    normalized.setdefault("answer", None)
    return normalized


def _content_hash(questions: list[dict[str, Any]]) -> str:
    canonical = json.dumps(
        questions, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _source_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


class ExtractionStore:
    """Append-only store: every extraction event becomes one immutable-slug JSON file."""

    def __init__(self, out_dir: Path) -> None:
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)

    # ── write path ────────────────────────────────────────────────

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_questions = payload.get("questions")
        if not isinstance(raw_questions, list) or not raw_questions:
            raise CollectorError(400, "invalid_questions", "questions 必须是非空数组。")
        if len(raw_questions) > MAX_QUESTIONS_PER_EXTRACTION:
            raise CollectorError(
                400,
                "too_many_questions",
                f"单次提取最多 {MAX_QUESTIONS_PER_EXTRACTION} 道题。",
            )
        questions = [_normalize_question(question) for question in raw_questions]

        source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
        record = {
            "id": "",  # assigned below once unique
            "savedAt": utc_now(),
            "contentHash": _content_hash(questions),
            "questionCount": len(questions),
            "source": {
                "url": _source_text(payload.get("url") or source.get("url")),
                "title": _source_text(payload.get("title") or source.get("title")),
                "extractedAt": _source_text(payload.get("extractedAt") or source.get("extractedAt")),
            },
            "questions": questions,
        }
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        base_hash = record["contentHash"][:8]
        record_id = f"{stamp}-{base_hash}"
        counter = 2
        # Keep-all policy: identical content re-collected within the same second
        # still deserves its own file, so disambiguate with a counter.
        while (self.out_dir / f"{record_id}.json").exists():
            record_id = f"{stamp}-{base_hash}-{counter}"
            counter += 1
        record["id"] = record_id
        self.write(record)
        return record

    def write(self, record: dict[str, Any]) -> None:
        """Atomically (re)write one extraction record, e.g. after solving."""
        extraction_id = record.get("id")
        if not isinstance(extraction_id, str) or not ID_PATTERN.match(extraction_id):
            raise CollectorError(400, "invalid_id", "提取记录 ID 无效。")
        target = self.out_dir / f"{extraction_id}.json"
        fd, tmp_name = tempfile.mkstemp(dir=self.out_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False, indent=2)
            os.replace(tmp_name, target)
        except BaseException:
            with suppress(OSError):
                os.unlink(tmp_name)
            raise

    # ── read path ─────────────────────────────────────────────────

    def _summaries(self) -> list[dict[str, Any]]:
        summaries: list[dict[str, Any]] = []
        for path in self.out_dir.glob("*.json"):
            record = self._read_file(path)
            if record is not None:
                summaries.append(self.summarize(record))
        summaries.sort(key=lambda item: item["id"], reverse=True)
        return summaries

    @staticmethod
    def _read_file(path: Path) -> dict[str, Any] | None:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return record if isinstance(record, dict) else None

    @staticmethod
    def summarize(record: dict[str, Any]) -> dict[str, Any]:
        questions = record.get("questions")
        questions = questions if isinstance(questions, list) else []
        solved = sum(
            1
            for question in questions
            if isinstance(question, dict) and question.get("answer") is not None
        )
        source = record.get("source") if isinstance(record.get("source"), dict) else {}
        return {
            "id": record.get("id"),
            "savedAt": record.get("savedAt"),
            "contentHash": record.get("contentHash"),
            "questionCount": record.get("questionCount", len(questions)),
            "solvedCount": solved,
            "source": {
                "url": source.get("url", ""),
                "title": source.get("title", ""),
                "extractedAt": source.get("extractedAt", ""),
            },
        }

    def list(self, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        summaries = self._summaries()
        return {
            "total": len(summaries),
            "items": summaries[offset : offset + limit],
        }

    def load(self, extraction_id: str) -> dict[str, Any]:
        if not isinstance(extraction_id, str) or not ID_PATTERN.match(extraction_id):
            raise CollectorError(400, "invalid_id", "提取记录 ID 无效。")
        record = self._read_file(self.out_dir / f"{extraction_id}.json")
        if record is None:
            raise CollectorError(404, "not_found", "提取记录不存在。")
        return record

    def stats(self) -> dict[str, Any]:
        summaries = self._summaries()
        return {
            "extractions": len(summaries),
            "questions": sum(item["questionCount"] or 0 for item in summaries),
            "solved": sum(item["solvedCount"] or 0 for item in summaries),
            "lastSavedAt": summaries[0]["savedAt"] if summaries else None,
        }

    def _question_haystack(self, question: dict[str, Any]) -> str:
        parts = [question.get("stem"), question.get("rawText")]
        options = question.get("options")
        if isinstance(options, dict):
            parts.extend(str(value) for value in options.values())
        elif isinstance(options, list):
            for option in options:
                if isinstance(option, dict):
                    parts.extend(str(option.get(key)) for key in ("key", "text", "value"))
                else:
                    parts.append(str(option))
        answer = question.get("answer")
        if isinstance(answer, list):
            parts.extend(str(item) for item in answer)
        elif answer is not None:
            parts.append(str(answer))
        return "\n".join(str(part) for part in parts if part).lower()

    def search(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        """Case-insensitive substring search across stems, options and answers.

        Hits are question-level and newest extraction first, so the UI can
        jump straight to extraction + question index.
        """
        needle = str(query or "").strip().lower()
        if not needle:
            return []
        limit = max(1, min(int(limit), 200))
        hits: list[dict[str, Any]] = []
        for path in sorted(self.out_dir.glob("*.json"), reverse=True):
            record = self._read_file(path)
            if not record:
                continue
            questions = record.get("questions")
            if not isinstance(questions, list):
                continue
            for index, question in enumerate(questions):
                if not isinstance(question, dict):
                    continue
                if needle not in self._question_haystack(question):
                    continue
                stem = str(question.get("stem") or "")
                hits.append({
                    "extractionId": record.get("id"),
                    "savedAt": record.get("savedAt"),
                    "questionIndex": index,
                    "stem": stem[:200],
                    "answer": question.get("answer"),
                })
                if len(hits) >= limit:
                    return hits
        return hits
