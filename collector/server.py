"""Local collector server: ingest page extractions, serve the mobile bank UI."""

from __future__ import annotations

import argparse
import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .service import CollectorError, ExtractionStore
from .solver import (
    load_config,
    mask_config,
    save_config,
    solve_for_extraction,
    test_connection,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = PROJECT_ROOT / "data" / "extractions"
DEFAULT_CONFIG = PROJECT_ROOT / "data" / "collector_config.json"
DEFAULT_STATIC = PROJECT_ROOT / "collector" / "web"


class CollectorHandler(BaseHTTPRequestHandler):
    store: ExtractionStore
    config_path: Path
    static_root: Path

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/v1/health":
                self._send_json({"status": "ok", "service": "CyberWikiBench Collector"})
                return
            if path == "/api/v1/stats":
                self._send_json(self.store.stats())
                return
            if path == "/api/v1/model-config":
                self._send_json(mask_config(load_config(self.config_path)))
                return
            if path == "/api/v1/extractions":
                query = parse_qs(parsed.query)
                limit = query.get("limit", ["50"])[0]
                offset = query.get("offset", ["0"])[0]
                self._send_json(self.store.list(limit, offset))
                return
            if path.startswith("/api/v1/extractions/"):
                extraction_id = unquote(path.removeprefix("/api/v1/extractions/"))
                self._send_json(self.store.load(extraction_id))
                return
            if path.startswith("/api/"):
                raise CollectorError(404, "not_found", "API 路径不存在。")
            self._serve_static(path)
        except CollectorError as exc:
            self._send_collector_error(exc)
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self.log_error("Unhandled GET error: %s", exc)
            self._send_collector_error(CollectorError(500, "internal_error", "服务端内部错误。"))

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            payload = self._read_json()
            if path == "/api/v1/extractions":
                record = self.store.save(payload)
                self._send_json(
                    {
                        "saved": True,
                        "extraction": {
                            "id": record["id"],
                            "questionCount": record["questionCount"],
                            "contentHash": record["contentHash"],
                        },
                    },
                    status=HTTPStatus.CREATED,
                )
                return
            if path == "/api/v1/solve":
                outcome = solve_for_extraction(
                    self.store,
                    load_config(self.config_path),
                    str(payload.get("extractionId") or ""),
                    payload.get("questionIndexes"),
                    force=payload.get("force") is True,
                )
                self._send_json(outcome)
                return
            if path == "/api/v1/model-config/test":
                outcome = test_connection(load_config(self.config_path))
                self._send_json(outcome)
                return
            raise CollectorError(404, "not_found", "API 路径不存在。")
        except CollectorError as exc:
            self._send_collector_error(exc)
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self.log_error("Unhandled POST error: %s", exc)
            self._send_collector_error(CollectorError(500, "internal_error", "服务端内部错误。"))

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path != "/api/v1/model-config":
                raise CollectorError(404, "not_found", "API 路径不存在。")
            payload = self._read_json()
            saved = save_config(self.config_path, payload)
            self._send_json(mask_config(saved))
        except CollectorError as exc:
            self._send_collector_error(exc)
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            self.log_error("Unhandled PUT error: %s", exc)
            self._send_collector_error(CollectorError(500, "internal_error", "服务端内部错误。"))

    def _read_json(self) -> dict:
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            raise CollectorError(415, "unsupported_media_type", "请求必须使用 application/json。")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise CollectorError(400, "invalid_content_length", "Content-Length 无效。") from exc
        if length < 1 or length > 2 * 1024 * 1024:
            raise CollectorError(400, "invalid_body_size", "请求体大小无效。")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CollectorError(400, "invalid_json", "请求体不是有效 UTF-8 JSON。") from exc
        if not isinstance(payload, dict):
            raise CollectorError(400, "invalid_json_object", "请求体必须是 JSON 对象。")
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

    def _send_collector_error(self, error: CollectorError) -> None:
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
    out_dir: Path = DEFAULT_OUT,
    config_path: Path = DEFAULT_CONFIG,
    static_root: Path = DEFAULT_STATIC,
) -> ThreadingHTTPServer:
    handler = type(
        "ConfiguredCollectorHandler",
        (CollectorHandler,),
        {
            "store": ExtractionStore(out_dir),
            "config_path": Path(config_path),
            "static_root": Path(static_root).resolve(),
        },
    )
    return ThreadingHTTPServer((host, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description="CyberWikiBench question collector server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--static", type=Path, default=DEFAULT_STATIC)
    args = parser.parse_args()

    server = create_server(args.host, args.port, args.out, args.config, args.static)
    print(f"CyberWikiBench Collector running at http://{args.host}:{args.port}")
    print("Tip: use --host 0.0.0.0 to reach the mobile UI from a phone on your LAN.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
