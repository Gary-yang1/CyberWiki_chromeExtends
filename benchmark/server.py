from __future__ import annotations

import argparse
import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .service import APIError, BenchmarkService, QuestionBank, RunStore


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BANK = PROJECT_ROOT / "data" / "questions.jsonl"
DEFAULT_DB = PROJECT_ROOT / "data" / "benchmark_runs.sqlite3"
DEFAULT_STATIC = PROJECT_ROOT / "web"


class BenchmarkHandler(BaseHTTPRequestHandler):
    service: BenchmarkService
    static_root: Path

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/v1/health":
                self._send_json({"status": "ok", "service": "CyberWikiBench", "version": "0.1.0"})
                return
            if path == "/api/v1/stats":
                self._send_json(self.service.bank.stats())
                return
            if path.startswith("/api/v1/test-sets/"):
                test_set_id = unquote(path.removeprefix("/api/v1/test-sets/"))
                self._send_json(self.service.get_test_set(test_set_id))
                return
            if path.startswith("/api/v1/submissions/"):
                submission_id = unquote(path.removeprefix("/api/v1/submissions/"))
                self._send_json(self.service.get_submission(submission_id))
                return
            if path.startswith("/api/"):
                raise APIError(404, "not_found", "API 路径不存在")
            self._serve_static(path)
        except APIError as exc:
            self._send_api_error(exc)
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self.log_error("Unhandled GET error: %s", exc)
            self._send_api_error(APIError(500, "internal_error", "服务端内部错误"))

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            payload = self._read_json()
            if parsed.path == "/api/v1/test-sets":
                self._send_json(self.service.create_test_set(payload), status=HTTPStatus.CREATED)
                return
            if parsed.path == "/api/v1/submissions":
                self._send_json(self.service.grade_submission(payload), status=HTTPStatus.CREATED)
                return
            raise APIError(404, "not_found", "API 路径不存在")
        except APIError as exc:
            self._send_api_error(exc)
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self.log_error("Unhandled POST error: %s", exc)
            self._send_api_error(APIError(500, "internal_error", "服务端内部错误"))

    def _read_json(self) -> dict:
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            raise APIError(415, "unsupported_media_type", "请求必须使用 application/json")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise APIError(400, "invalid_content_length", "Content-Length 无效") from exc
        if length < 1 or length > 2 * 1024 * 1024:
            raise APIError(400, "invalid_body_size", "请求体大小无效")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise APIError(400, "invalid_json", "请求体不是有效 UTF-8 JSON") from exc
        if not isinstance(payload, dict):
            raise APIError(400, "invalid_json_object", "请求体必须是 JSON 对象")
        return payload

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in {"", "/"} else unquote(path).lstrip("/")
        target = (self.static_root / relative).resolve()
        if not target.is_relative_to(self.static_root) or not target.is_file():
            target = self.static_root / "index.html"
        content = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self._cors_headers()
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def _send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_api_error(self, error: APIError) -> None:
        self._send_json(
            {"error": {"code": error.code, "message": error.message}}, status=error.status
        )

    def _cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")

    def log_message(self, format: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {format % args}")


def create_server(
    host: str,
    port: int,
    bank_path: Path = DEFAULT_BANK,
    db_path: Path = DEFAULT_DB,
    static_root: Path = DEFAULT_STATIC,
) -> ThreadingHTTPServer:
    service = BenchmarkService(QuestionBank(bank_path), RunStore(db_path))
    handler = type(
        "ConfiguredBenchmarkHandler",
        (BenchmarkHandler,),
        {"service": service, "static_root": static_root.resolve()},
    )
    return ThreadingHTTPServer((host, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description="CyberWikiBench local GUI and API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bank", type=Path, default=DEFAULT_BANK)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--static", type=Path, default=DEFAULT_STATIC)
    args = parser.parse_args()

    server = create_server(args.host, args.port, args.bank, args.db, args.static)
    print(f"CyberWikiBench running at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
