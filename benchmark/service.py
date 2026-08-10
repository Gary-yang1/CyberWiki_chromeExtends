from __future__ import annotations

import json
import math
import random
import secrets
import sqlite3
import statistics
import uuid
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class APIError(ValueError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(percent * len(ordered)) - 1))
    return round(float(ordered[index]), 3)


class QuestionBank:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.questions = self._load(path)
        self.by_id = {question["id"]: question for question in self.questions}
        if len(self.by_id) != len(self.questions):
            raise ValueError("题库存在重复 ID")

    @staticmethod
    def _load(path: Path) -> list[dict[str, Any]]:
        questions: list[dict[str, Any]] = []
        for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
            if not line.strip():
                continue
            try:
                question = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"题库第 {line_number} 行 JSON 无法解析: {exc.msg}") from exc
            if question.get("metadata", {}).get("quality_status") == "rejected":
                continue
            questions.append(question)
        if not questions:
            raise ValueError("题库为空")
        return questions

    def stats(self) -> dict[str, Any]:
        type_counts = Counter(question["type"] for question in self.questions)
        source_counts = Counter(question["source"]["collection"] for question in self.questions)
        domain_counts = Counter(
            question["metadata"].get("domain") or "unlabeled" for question in self.questions
        )
        return {
            "question_count": len(self.questions),
            "type_counts": dict(sorted(type_counts.items())),
            "source_counts": dict(sorted(source_counts.items())),
            "domain_counts": dict(sorted(domain_counts.items())),
        }

    @staticmethod
    def public_question(question: dict[str, Any], index: int) -> dict[str, Any]:
        return {
            "index": index,
            "id": question["id"],
            "type": question["type"],
            "stem": question["stem"],
            "options": question["options"],
            "source": {"collection": question["source"]["collection"]},
            "metadata": {
                "domain": question["metadata"].get("domain"),
                "subdomain": question["metadata"].get("subdomain"),
                "difficulty": question["metadata"].get("difficulty"),
                "tags": question["metadata"].get("tags", []),
            },
        }

    def filter_questions(
        self,
        types: list[str],
        sources: list[str],
        domains: list[str],
    ) -> list[dict[str, Any]]:
        return [
            question
            for question in self.questions
            if question["type"] in types
            and (not sources or question["source"]["collection"] in sources)
            and (not domains or (question["metadata"].get("domain") or "unlabeled") in domains)
        ]


class RunStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS test_sets (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    config_json TEXT NOT NULL,
                    question_ids_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS submissions (
                    id TEXT PRIMARY KEY,
                    test_set_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    FOREIGN KEY(test_set_id) REFERENCES test_sets(id)
                );
                CREATE INDEX IF NOT EXISTS idx_submissions_test_set
                    ON submissions(test_set_id);
                """
            )
            connection.commit()

    def save_test_set(self, test_set: dict[str, Any]) -> None:
        with closing(self._connect()) as connection:
            connection.execute(
                "INSERT INTO test_sets(id, created_at, config_json, question_ids_json) VALUES (?, ?, ?, ?)",
                (
                    test_set["id"],
                    test_set["created_at"],
                    json.dumps(test_set["config"], ensure_ascii=False),
                    json.dumps(test_set["question_ids"], ensure_ascii=False),
                ),
            )
            connection.commit()

    def get_test_set(self, test_set_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM test_sets WHERE id = ?", (test_set_id,)
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "config": json.loads(row["config_json"]),
            "question_ids": json.loads(row["question_ids_json"]),
        }

    def save_submission(self, result: dict[str, Any]) -> None:
        with closing(self._connect()) as connection:
            connection.execute(
                "INSERT INTO submissions(id, test_set_id, created_at, result_json) VALUES (?, ?, ?, ?)",
                (
                    result["id"],
                    result["test_set_id"],
                    result["created_at"],
                    json.dumps(result, ensure_ascii=False),
                ),
            )
            connection.commit()

    def get_submission(self, submission_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT result_json FROM submissions WHERE id = ?", (submission_id,)
            ).fetchone()
        return json.loads(row["result_json"]) if row else None


class BenchmarkService:
    VALID_TYPES = {"single_choice", "true_false"}

    def __init__(self, bank: QuestionBank, store: RunStore) -> None:
        self.bank = bank
        self.store = store

    def create_test_set(self, payload: dict[str, Any]) -> dict[str, Any]:
        requested_types = payload.get("types") or sorted(self.VALID_TYPES)
        if not isinstance(requested_types, list) or not requested_types:
            raise APIError(400, "invalid_types", "types 必须是非空数组")
        types = list(dict.fromkeys(requested_types))
        if any(question_type not in self.VALID_TYPES for question_type in types):
            raise APIError(400, "invalid_types", "不支持的题型")

        sources = payload.get("sources") or []
        domains = payload.get("domains") or []
        if not isinstance(sources, list) or not all(isinstance(value, str) for value in sources):
            raise APIError(400, "invalid_sources", "sources 必须是字符串数组")
        if not isinstance(domains, list) or not all(isinstance(value, str) for value in domains):
            raise APIError(400, "invalid_domains", "domains 必须是字符串数组")

        try:
            count = int(payload.get("count", 20))
        except (TypeError, ValueError) as exc:
            raise APIError(400, "invalid_count", "count 必须是整数") from exc
        if count < 1 or count > 1000:
            raise APIError(400, "invalid_count", "count 必须在 1 到 1000 之间")

        seed_value = payload.get("seed")
        if seed_value in (None, ""):
            seed = secrets.randbits(63)
        else:
            try:
                seed = int(seed_value)
            except (TypeError, ValueError) as exc:
                raise APIError(400, "invalid_seed", "seed 必须是整数") from exc

        candidates = self.bank.filter_questions(types, sources, domains)
        if count > len(candidates):
            raise APIError(
                400,
                "insufficient_questions",
                f"筛选后只有 {len(candidates)} 题，无法抽取 {count} 题",
            )

        rng = random.Random(seed)
        selected = rng.sample(candidates, count)
        test_set = {
            "id": f"set-{uuid.uuid4().hex}",
            "created_at": utc_now(),
            "config": {
                "types": types,
                "sources": sources,
                "domains": domains,
                "count": count,
                "seed": seed,
            },
            "question_ids": [question["id"] for question in selected],
        }
        self.store.save_test_set(test_set)
        return self._public_test_set(test_set)

    def get_test_set(self, test_set_id: str) -> dict[str, Any]:
        test_set = self.store.get_test_set(test_set_id)
        if not test_set:
            raise APIError(404, "test_set_not_found", "测试集不存在")
        return self._public_test_set(test_set)

    def _public_test_set(self, test_set: dict[str, Any]) -> dict[str, Any]:
        questions = [self.bank.by_id[question_id] for question_id in test_set["question_ids"]]
        return {
            "id": test_set["id"],
            "created_at": test_set["created_at"],
            "config": test_set["config"],
            "questions": [
                self.bank.public_question(question, index)
                for index, question in enumerate(questions, start=1)
            ],
        }

    def grade_submission(self, payload: dict[str, Any]) -> dict[str, Any]:
        test_set_id = payload.get("test_set_id")
        if not isinstance(test_set_id, str) or not test_set_id:
            raise APIError(400, "missing_test_set_id", "缺少 test_set_id")
        test_set = self.store.get_test_set(test_set_id)
        if not test_set:
            raise APIError(404, "test_set_not_found", "测试集不存在")

        submitted_items = payload.get("answers") or []
        if not isinstance(submitted_items, list):
            raise APIError(400, "invalid_answers", "answers 必须是数组")
        allowed_ids = set(test_set["question_ids"])
        answers: dict[str, dict[str, Any]] = {}
        for item in submitted_items:
            if not isinstance(item, dict) or not isinstance(item.get("question_id"), str):
                raise APIError(400, "invalid_answer_item", "答案项必须包含 question_id")
            question_id = item["question_id"]
            if question_id not in allowed_ids:
                raise APIError(400, "unexpected_question", f"题目 {question_id} 不属于该测试集")
            if question_id in answers:
                raise APIError(400, "duplicate_answer", f"题目 {question_id} 重复提交")
            answers[question_id] = item

        details: list[dict[str, Any]] = []
        latency_values: list[float] = []
        for index, question_id in enumerate(test_set["question_ids"], start=1):
            question = self.bank.by_id[question_id]
            item = answers.get(question_id, {})
            submitted_answer = self._normalize_answer(question, item.get("answer"))
            is_answered = submitted_answer is not None
            is_correct = is_answered and submitted_answer == question["answer"]
            latency_ms = item.get("latency_ms")
            if isinstance(latency_ms, (int, float)) and latency_ms >= 0:
                latency_values.append(float(latency_ms))
            else:
                latency_ms = None
            details.append(
                {
                    "index": index,
                    "question_id": question_id,
                    "type": question["type"],
                    "stem": question["stem"],
                    "options": question["options"],
                    "submitted_answer": submitted_answer,
                    "correct_answer": question["answer"],
                    "is_answered": is_answered,
                    "is_correct": is_correct,
                    "latency_ms": latency_ms,
                    "raw_output": item.get("raw_output"),
                    "explanation": question.get("explanation"),
                    "evidence": question.get("evidence", []),
                }
            )

        correct = sum(1 for detail in details if detail["is_correct"])
        answered = sum(1 for detail in details if detail["is_answered"])
        by_type: dict[str, dict[str, Any]] = {}
        for question_type in sorted(self.VALID_TYPES):
            typed = [detail for detail in details if detail["type"] == question_type]
            if typed:
                typed_correct = sum(1 for detail in typed if detail["is_correct"])
                by_type[question_type] = {
                    "total": len(typed),
                    "correct": typed_correct,
                    "accuracy": typed_correct / len(typed),
                }
        client = payload.get("client") if isinstance(payload.get("client"), dict) else {}
        total_latency_ms = payload.get("total_latency_ms")
        if not isinstance(total_latency_ms, (int, float)) or total_latency_ms < 0:
            total_latency_ms = None

        result = {
            "id": f"submission-{uuid.uuid4().hex}",
            "test_set_id": test_set_id,
            "created_at": utc_now(),
            "client": client,
            "summary": {
                "total": len(details),
                "answered": answered,
                "correct": correct,
                "accuracy": correct / len(details) if details else 0.0,
                "total_latency_ms": total_latency_ms,
                "latency": {
                    "count": len(latency_values),
                    "mean_ms": round(statistics.fmean(latency_values), 3) if latency_values else None,
                    "p50_ms": round(statistics.median(latency_values), 3) if latency_values else None,
                    "p95_ms": percentile(latency_values, 0.95),
                },
                "by_type": by_type,
            },
            "details": details,
        }
        self.store.save_submission(result)
        return result

    def get_submission(self, submission_id: str) -> dict[str, Any]:
        result = self.store.get_submission(submission_id)
        if not result:
            raise APIError(404, "submission_not_found", "评分结果不存在")
        return result

    @staticmethod
    def _normalize_answer(question: dict[str, Any], answer: Any) -> Any:
        if answer is None:
            return None
        if question["type"] == "true_false":
            if isinstance(answer, bool):
                return answer
            if isinstance(answer, str):
                normalized = answer.strip().lower()
                if normalized in {"true", "t", "1", "yes", "正确", "对"}:
                    return True
                if normalized in {"false", "f", "0", "no", "错误", "错"}:
                    return False
            return None
        if isinstance(answer, str):
            normalized = answer.strip().upper()
            valid_keys = {option["key"] for option in question["options"]}
            return normalized if normalized in valid_keys else None
        return None
