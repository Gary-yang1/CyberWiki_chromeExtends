from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from collector.auth import load_users, resolve_user
from collector.service import CollectorError, ExtractionStore, user_out_dir
from collector.solver import (
    build_messages,
    load_config,
    mask_config,
    parse_answer,
    save_config,
    solve_for_extraction,
    test_connection,
)


def sample_payload(stem: str = "1+1=?") -> dict:
    return {
        "url": "https://quiz.example/page",
        "title": "示例页面",
        "extractedAt": "2026-08-17T10:00:00+00:00",
        "questions": [
            {
                "id": "q1",
                "type": "single_choice",
                "stem": stem,
                "options": {"A": "1", "B": "2"},
            },
            {"id": "q2", "type": "true_false", "stem": "地球绕太阳转。"},
        ],
    }


class ExtractionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = ExtractionStore(Path(self.temporary_directory.name) / "extractions")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_save_writes_one_file_per_extraction_with_expected_fields(self) -> None:
        record = self.store.save(sample_payload())
        path = Path(self.temporary_directory.name) / "extractions" / f"{record['id']}.json"
        self.assertTrue(path.is_file())
        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["questionCount"], 2)
        self.assertEqual(persisted["source"]["url"], "https://quiz.example/page")
        self.assertEqual(len(persisted["contentHash"]), 16)
        self.assertTrue(all(q["answer"] is None for q in persisted["questions"]))

    def test_identical_payloads_are_both_kept(self) -> None:
        first = self.store.save(sample_payload())
        second = self.store.save(sample_payload())
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["contentHash"], second["contentHash"])

    def test_list_orders_newest_first_and_paginates(self) -> None:
        for index in range(3):
            self.store.save(sample_payload(f"题目 {index}"))
        listing = self.store.list(limit=2, offset=0)
        self.assertEqual(listing["total"], 3)
        self.assertEqual(len(listing["items"]), 2)
        rest = self.store.list(limit=2, offset=2)
        self.assertEqual(len(rest["items"]), 1)

    def test_load_rejects_invalid_ids(self) -> None:
        with self.assertRaises(CollectorError):
            self.store.load("../../etc/passwd")
        with self.assertRaises(CollectorError):
            self.store.load("20260817T000000Z-zzzzzzzz")

    def test_save_rejects_empty_or_malformed_questions(self) -> None:
        with self.assertRaises(CollectorError):
            self.store.save({"questions": []})
        with self.assertRaises(CollectorError):
            self.store.save({"questions": [{"options": {}}]})
        with self.assertRaises(CollectorError):
            self.store.save({"questions": "not-a-list"})

    def test_stats_counts_extractions_questions_and_solved(self) -> None:
        record = self.store.save(sample_payload())
        record["questions"][0]["answer"] = "B"
        self.store.write(record)
        stats = self.store.stats()
        self.assertEqual(stats["extractions"], 1)
        self.assertEqual(stats["questions"], 2)
        self.assertEqual(stats["solved"], 1)
        self.assertIsNotNone(stats["lastSavedAt"])


class SolverConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temporary_directory.name) / "collector_config.json"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_save_and_mask_round_trip_keeps_key_on_empty_update(self) -> None:
        save_config(self.config_path, {
            "endpoint": "https://api.deepseek.com/v1",
            "apiKey": "sk-secret-1234",
            "model": "deepseek-chat",
        })
        # UI sends empty apiKey to mean "keep the stored one".
        updated = save_config(self.config_path, {
            "endpoint": "https://api.deepseek.com/v1",
            "apiKey": "",
            "model": "deepseek-reasoner",
        })
        self.assertEqual(updated["apiKey"], "sk-secret-1234")
        masked = mask_config(load_config(self.config_path))
        self.assertNotIn("apiKey", masked)
        self.assertTrue(masked["hasApiKey"])
        self.assertEqual(masked["apiKeyTail"], "1234")

    def test_missing_config_file_yields_defaults(self) -> None:
        config = load_config(self.config_path)
        self.assertEqual(config["endpoint"], "")
        self.assertEqual(config["apiKey"], "")


class SolverParsingTests(unittest.TestCase):
    def test_parses_plain_json_and_fenced_json(self) -> None:
        self.assertEqual(parse_answer('{"answer":"B","confidence":0.9}')["answer"], "B")
        fenced = '```json\n{"answer":["A","C"],"confidence":0.8}\n```'
        self.assertEqual(parse_answer(fenced)["answer"], ["A", "C"])

    def test_extracts_json_embedded_in_prose_and_falls_back_to_raw(self) -> None:
        noisy = '答案是 {"answer":true,"confidence":1} 谢谢'
        self.assertIs(parse_answer(noisy)["answer"], True)
        fallback = parse_answer("这题我也不会")
        self.assertIsNone(fallback["answer"])
        self.assertEqual(fallback["rawText"], "这题我也不会")

    def test_build_messages_contains_system_prompt_stem_and_options(self) -> None:
        messages = build_messages(sample_payload()["questions"][0])
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn("只输出 JSON", messages[0]["content"])
        user_text = messages[1]["content"]
        self.assertIn("1+1=?", user_text)
        self.assertIn("A. 1", user_text)
        self.assertIn("B. 2", user_text)


class SolverSolveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = ExtractionStore(Path(self.temporary_directory.name) / "extractions")
        self.config = {
            "endpoint": "https://api.deepseek.com/v1",
            "apiKey": "sk-test",
            "model": "deepseek-chat",
            "maxOutputTokens": 256,
            "timeoutMs": 5_000,
        }

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    @staticmethod
    def fake_transport(reply: str):
        def transport(body: dict) -> dict:
            return {"choices": [{"message": {"content": reply}}]}
        return transport

    def test_solve_for_extraction_persists_answers_and_skips_solved(self) -> None:
        record = self.store.save(sample_payload())
        outcome = solve_for_extraction(
            self.store, self.config, record["id"], [0], transport=self.fake_transport('{"answer":"B","confidence":0.9}')
        )
        self.assertEqual(outcome["solved"], 1)
        persisted = self.store.load(record["id"])
        self.assertEqual(persisted["questions"][0]["answer"], "B")
        self.assertEqual(persisted["questions"][0]["model"], "deepseek-chat")
        self.assertIsNone(persisted["questions"][1]["answer"])

        second = solve_for_extraction(
            self.store, self.config, record["id"], None, transport=self.fake_transport('{"answer":"A"}')
        )
        self.assertEqual(second["solved"], 1)
        self.assertTrue(second["results"][0]["skipped"])

    def test_unparsable_reply_is_kept_as_raw_text(self) -> None:
        record = self.store.save(sample_payload())
        solve_for_extraction(
            self.store, self.config, record["id"], [0], transport=self.fake_transport("模型咕哝了一句")
        )
        persisted = self.store.load(record["id"])
        self.assertIsNone(persisted["questions"][0]["answer"])
        self.assertEqual(persisted["questions"][0]["rawText"], "模型咕哝了一句")

    def test_unconfigured_model_raises_code(self) -> None:
        record = self.store.save(sample_payload())
        with self.assertRaises(CollectorError) as context:
            solve_for_extraction(self.store, {"endpoint": "", "apiKey": "", "model": ""}, record["id"])
        self.assertEqual(context.exception.code, "model_not_configured")

    def test_invalid_question_index_rejected(self) -> None:
        record = self.store.save(sample_payload())
        with self.assertRaises(CollectorError):
            solve_for_extraction(self.store, self.config, record["id"], [9])

    def test_test_connection_reports_latency(self) -> None:
        outcome = test_connection(self.config, transport=self.fake_transport("ok"))
        self.assertTrue(outcome["ok"])
        self.assertEqual(outcome["reply"], "ok")
        self.assertGreaterEqual(outcome["latencyMs"], 0)


if __name__ == "__main__":
    unittest.main()


class AuthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def write_auth(self, payload) -> Path:
        path = self.base / "auth.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_open_mode_defaults_to_shared_space(self) -> None:
        users = load_users(self.base / "missing.json")
        self.assertEqual(users, {})
        self.assertEqual(resolve_user(users, None, None), "default")

    def test_gated_mode_requires_matching_credentials(self) -> None:
        users = load_users(self.write_auth({"users": {"gary": "key-1", "alice": "key-2"}}))
        self.assertEqual(resolve_user(users, "gary", "key-1"), "gary")
        self.assertEqual(resolve_user(users, "alice", "key-2"), "alice")
        with self.assertRaises(CollectorError) as missing:
            resolve_user(users, None, None)
        self.assertEqual(missing.exception.status, 401)
        with self.assertRaises(CollectorError) as wrong:
            resolve_user(users, "gary", "key-2")
        self.assertEqual(wrong.exception.status, 401)
        with self.assertRaises(CollectorError) as unsafe:
            resolve_user(users, "../etc", "key-1")
        self.assertEqual(unsafe.exception.status, 401)

    def test_user_out_dir_rejects_traversal_and_scopes_storage(self) -> None:
        with self.assertRaises(CollectorError):
            user_out_dir(self.base, "../escape")
        with self.assertRaises(CollectorError):
            user_out_dir(self.base, "a" * 33)
        self.assertEqual(user_out_dir(self.base, "gary"), self.base / "gary")


class MultiUserIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name) / "extractions"
        self.gary = ExtractionStore(user_out_dir(self.base, "gary"))
        self.alice = ExtractionStore(user_out_dir(self.base, "alice"))

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_users_only_see_their_own_extractions(self) -> None:
        gary_record = self.gary.save(sample_payload("Gary 专用题目"))
        self.alice.save(sample_payload("Alice 专用题目"))
        self.assertEqual(self.gary.stats()["extractions"], 1)
        self.assertEqual(self.alice.stats()["extractions"], 1)
        self.assertEqual(self.alice.list()["items"][0]["source"]["title"], "示例页面")
        with self.assertRaises(CollectorError):
            self.alice.load(gary_record["id"])


class SearchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = ExtractionStore(Path(self.temporary_directory.name) / "extractions")
        record = self.store.save(sample_payload("SQL注入属于哪类攻击"))
        record["questions"][0]["answer"] = "A"
        self.store.write(record)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_search_matches_stems_options_and_answers(self) -> None:
        stem_hit = self.store.search("注入")[0]
        self.assertEqual(stem_hit["questionIndex"], 0)
        self.assertIn("SQL注入", stem_hit["stem"])

        option_hit = self.store.search("2")  # option B text "2"
        self.assertTrue(option_hit)

        answer_hit = self.store.search("A")
        self.assertTrue(any(hit["answer"] == "A" for hit in answer_hit))

    def test_search_is_case_insensitive_and_scoped(self) -> None:
        self.assertEqual(self.store.search("不存在的关键词xyz"), [])
        self.assertTrue(self.store.search("  sql注入  "))

    def test_empty_query_returns_nothing(self) -> None:
        self.assertEqual(self.store.search(""), [])
        self.assertEqual(self.store.search("   "), [])


class ExtractionDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = ExtractionStore(Path(self.temporary_directory.name) / "extractions")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_delete_removes_the_file_and_returns_last_summary(self) -> None:
        record = self.store.save(sample_payload())
        outcome = self.store.delete(record["id"])
        self.assertEqual(outcome["deleted"], True)
        self.assertEqual(outcome["id"], record["id"])
        self.assertEqual(outcome["summary"]["questionCount"], 2)
        with self.assertRaises(CollectorError):
            self.store.load(record["id"])

    def test_delete_missing_or_invalid_ids_is_rejected(self) -> None:
        with self.assertRaises(CollectorError) as missing:
            self.store.delete("20260817T000000Z-deadbeef")
        self.assertEqual(missing.exception.status, 404)
        with self.assertRaises(CollectorError) as invalid:
            self.store.delete("../../etc/passwd")
        self.assertEqual(invalid.exception.status, 400)
