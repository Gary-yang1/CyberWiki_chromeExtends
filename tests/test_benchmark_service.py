from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from benchmark.service import APIError, BenchmarkService, QuestionBank, RunStore


PROJECT_ROOT = Path(__file__).resolve().parent.parent


class BenchmarkServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        bank = QuestionBank(PROJECT_ROOT / "data" / "questions.jsonl")
        store = RunStore(Path(self.temporary_directory.name) / "runs.sqlite3")
        self.service = BenchmarkService(bank, store)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_stats_match_parsed_question_bank(self) -> None:
        stats = self.service.bank.stats()
        self.assertEqual(stats["question_count"], 931)
        self.assertEqual(stats["type_counts"]["single_choice"], 776)
        self.assertEqual(stats["type_counts"]["true_false"], 155)

    def test_deterministic_selection_does_not_expose_answers(self) -> None:
        payload = {"types": ["single_choice"], "count": 8, "seed": 20260810}
        first = self.service.create_test_set(payload)
        second = self.service.create_test_set(payload)
        self.assertEqual(
            [question["id"] for question in first["questions"]],
            [question["id"] for question in second["questions"]],
        )
        self.assertTrue(all("answer" not in question for question in first["questions"]))
        self.assertTrue(all("explanation" not in question for question in first["questions"]))

    def test_submission_is_graded_and_persisted(self) -> None:
        test_set = self.service.create_test_set(
            {"types": ["single_choice", "true_false"], "count": 10, "seed": 42}
        )
        answers = [
            {
                "question_id": question["id"],
                "answer": self.service.bank.by_id[question["id"]]["answer"],
                "latency_ms": 125,
            }
            for question in test_set["questions"]
        ]
        result = self.service.grade_submission(
            {"test_set_id": test_set["id"], "answers": answers, "total_latency_ms": 1250}
        )
        self.assertEqual(result["summary"]["accuracy"], 1.0)
        self.assertEqual(result["summary"]["latency"]["p95_ms"], 125.0)
        self.assertEqual(self.service.get_submission(result["id"]), result)

    def test_invalid_count_is_rejected(self) -> None:
        with self.assertRaises(APIError) as context:
            self.service.create_test_set({"types": ["true_false"], "count": 200})
        self.assertEqual(context.exception.code, "insufficient_questions")


if __name__ == "__main__":
    unittest.main()
