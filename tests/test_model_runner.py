from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from scripts.run_model_benchmark import call_model, parse_model_answer


class MockModelHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        json.loads(self.rfile.read(length).decode("utf-8"))
        body = json.dumps(
            {"choices": [{"message": {"content": '{"answer":"C"}'}}]}
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


class ModelRunnerTests(unittest.TestCase):
    def test_parse_structured_single_choice(self) -> None:
        self.assertEqual(parse_model_answer('{"answer":"b"}', "single_choice"), "B")

    def test_parse_structured_true_false(self) -> None:
        self.assertIs(parse_model_answer('{"answer":false}', "true_false"), False)
        self.assertIs(parse_model_answer("答案：正确", "true_false"), True)

    def test_call_openai_compatible_model(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), MockModelHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = call_model(
                f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
                "mock-model",
                None,
                "只输出答案",
                {
                    "id": "test-1",
                    "type": "single_choice",
                    "stem": "测试题",
                    "options": [
                        {"key": "A", "text": "一"},
                        {"key": "B", "text": "二"},
                        {"key": "C", "text": "三"},
                    ],
                },
                5,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertEqual(result["question_id"], "test-1")
        self.assertEqual(result["answer"], "C")
        self.assertGreaterEqual(result["latency_ms"], 0)


if __name__ == "__main__":
    unittest.main()
