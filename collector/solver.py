"""Server-side AI answering over an OpenAI-compatible chat/completions endpoint."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from .service import CollectorError, ExtractionStore, utc_now

Transport = Callable[[dict[str, Any]], dict[str, Any]]

DEFAULT_CONFIG: dict[str, Any] = {
    "endpoint": "",  # base address, e.g. https://api.deepseek.com/v1
    "apiKey": "",
    "model": "",
    "maxOutputTokens": 512,
    "timeoutMs": 60_000,
}

# Mirrors the extension's DEFAULT_SYSTEM_PROMPT (src/shared/storage.js) so
# bank answers and overlay answers follow the same contract.
SYSTEM_PROMPT = "\n".join(
    [
        "你是网络安全知识题做题助手。",
        "根据题干和选项给出最可能正确的答案。",
        "只输出 JSON，不要输出 Markdown 或推理过程。",
        '单选题格式：{"answer":"A","confidence":0.0}。',
        '多选题格式：{"answer":["A","B"],"confidence":0.0}。',
        '判断题格式：{"answer":true,"confidence":0.0}。',
    ]
)

JSON_OBJECT_PATTERN = re.compile(r"\{.*\}", re.DOTALL)


# ── model configuration ───────────────────────────────────────────


def _normalize_config(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    timeout = source.get("timeoutMs", DEFAULT_CONFIG["timeoutMs"])
    try:
        timeout = min(max(int(timeout), 1_000), 300_000)
    except (TypeError, ValueError):
        timeout = DEFAULT_CONFIG["timeoutMs"]
    tokens = source.get("maxOutputTokens", DEFAULT_CONFIG["maxOutputTokens"])
    try:
        tokens = min(max(int(tokens), 16), 8_192)
    except (TypeError, ValueError):
        tokens = DEFAULT_CONFIG["maxOutputTokens"]
    return {
        "endpoint": str(source.get("endpoint") or "").strip(),
        "apiKey": str(source.get("apiKey") or "").strip(),
        "model": str(source.get("model") or "").strip(),
        "maxOutputTokens": tokens,
        "timeoutMs": timeout,
    }


def load_config(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_CONFIG)
    return _normalize_config(raw)


def save_config(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    """Persist the UI-provided config; an empty apiKey keeps the stored one."""
    normalized = _normalize_config(payload)
    previous = load_config(path)
    if not normalized["apiKey"]:
        normalized["apiKey"] = previous["apiKey"]
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return normalized


def mask_config(config: dict[str, Any]) -> dict[str, Any]:
    """Never echo the full key back to the browser."""
    api_key = config.get("apiKey") or ""
    return {
        "endpoint": config.get("endpoint", ""),
        "model": config.get("model", ""),
        "maxOutputTokens": config.get("maxOutputTokens", DEFAULT_CONFIG["maxOutputTokens"]),
        "timeoutMs": config.get("timeoutMs", DEFAULT_CONFIG["timeoutMs"]),
        "hasApiKey": bool(api_key),
        "apiKeyTail": api_key[-4:] if len(api_key) > 4 else "",
    }


def is_configured(config: dict[str, Any]) -> bool:
    return bool(config.get("endpoint") and config.get("model") and config.get("apiKey"))


def require_config(config: dict[str, Any]) -> dict[str, Any]:
    if not is_configured(config):
        raise CollectorError(
            400, "model_not_configured", "请先在设置页配置模型接口、API Key 和模型 ID。"
        )
    return config


# ── prompt & parsing ──────────────────────────────────────────────


def _chat_url(endpoint: str) -> str:
    base = endpoint.rstrip("/")
    return base if base.endswith("/chat/completions") else f"{base}/chat/completions"


def _options_block(question: dict[str, Any]) -> str:
    options = question.get("options")
    if isinstance(options, dict):
        items = list(options.items())
    elif isinstance(options, list):
        items = [
            (
                option.get("key") or option.get("label") or chr(ord("A") + index),
                option.get("text") or option.get("value") or "",
            )
            for index, option in enumerate(options)
            if isinstance(option, dict)
        ]
    else:
        return ""
    lines = [f"{key}. {text}" for key, text in items if str(key).strip()]
    return "\n".join(lines)


def build_messages(question: dict[str, Any]) -> list[dict[str, str]]:
    stem = str(question.get("stem") or "").strip()
    blocks = [f"题目：{stem}"]
    options = _options_block(question)
    if options:
        blocks.append(f"选项：\n{options}")
    question_type = str(question.get("type") or "").strip()
    if question_type:
        blocks.append(f"题型：{question_type}")
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(blocks)},
    ]


def parse_answer(text: str) -> dict[str, Any]:
    """Extract {"answer":..., "confidence":...} from model output; fall back to rawText."""
    raw = str(text or "").strip()
    candidate = raw
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", raw, re.DOTALL)
    if fence:
        candidate = fence.group(1)
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        match = JSON_OBJECT_PATTERN.search(candidate)
        if not match:
            return {"answer": None, "confidence": None, "rawText": raw[:2_000]}
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {"answer": None, "confidence": None, "rawText": raw[:2_000]}
    if not isinstance(parsed, dict) or "answer" not in parsed:
        return {"answer": None, "confidence": None, "rawText": raw[:2_000]}
    confidence = parsed.get("confidence")
    try:
        confidence = min(max(float(confidence), 0.0), 1.0)
    except (TypeError, ValueError):
        confidence = None
    return {"answer": parsed["answer"], "confidence": confidence, "rawText": None}


# ── transport ─────────────────────────────────────────────────────


def default_transport(config: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        _chat_url(config["endpoint"]),
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config['apiKey']}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=config["timeoutMs"] / 1000) as response:
        return json.loads(response.read().decode("utf-8"))


def _request_model(
    config: dict[str, Any],
    messages: list[dict[str, str]],
    transport: Transport | None,
) -> tuple[str, int]:
    body = {
        "model": config["model"],
        "messages": messages,
        "max_tokens": config["maxOutputTokens"],
        "temperature": 0,
    }
    send = transport or (lambda payload: default_transport(config, payload))
    started = time.monotonic()
    try:
        data = send(body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500] if exc.fp else ""
        raise CollectorError(
            502,
            "model_http_error",
            f"模型服务返回 HTTP {exc.code}。{detail}".strip(),
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CollectorError(502, "model_network_error", f"无法连接模型服务：{exc}") from exc
    latency_ms = round((time.monotonic() - started) * 1000)
    text = ""
    choices = data.get("choices") if isinstance(data, dict) else None
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(message, dict):
            content = message.get("content")
            text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    if not text:
        raise CollectorError(502, "model_empty_response", "模型没有返回内容。")
    return text, latency_ms


def solve_question(
    config: dict[str, Any],
    question: dict[str, Any],
    *,
    transport: Transport | None = None,
) -> dict[str, Any]:
    """Solve one question; never raises on unparsable output (rawText carries it)."""
    require_config(config)
    text, latency_ms = _request_model(config, build_messages(question), transport)
    parsed = parse_answer(text)
    return {
        **parsed,
        "model": config["model"],
        "solvedAt": utc_now(),
        "latencyMs": latency_ms,
    }


def test_connection(config: dict[str, Any], *, transport: Transport | None = None) -> dict[str, Any]:
    require_config(config)
    text, latency_ms = _request_model(
        config,
        [
            {"role": "system", "content": "Reply with exactly: ok"},
            {"role": "user", "content": "ping"},
        ],
        transport,
    )
    return {"ok": True, "reply": text.strip()[:200], "latencyMs": latency_ms}


# ── extraction-level solving ──────────────────────────────────────


def solve_for_extraction(
    store: ExtractionStore,
    config: dict[str, Any],
    extraction_id: str,
    question_indexes: list[int] | None = None,
    *,
    force: bool = False,
    transport: Transport | None = None,
) -> dict[str, Any]:
    """Solve selected questions and persist answers back into the extraction file."""
    record = store.load(extraction_id)
    questions = record.get("questions")
    if not isinstance(questions, list) or not questions:
        raise CollectorError(400, "invalid_extraction", "该提取记录没有题目。")
    if question_indexes is None:
        targets = list(range(len(questions)))
    else:
        targets = []
        for index in question_indexes:
            if not isinstance(index, int) or not 0 <= index < len(questions):
                raise CollectorError(400, "invalid_question_index", f"题目序号无效：{index}")
            targets.append(index)

    require_config(config)
    results: list[dict[str, Any]] = []
    solved = 0
    for index in dict.fromkeys(targets):  # de-duplicate, keep order
        question = questions[index]
        already = (
            isinstance(question, dict)
            and question.get("answer") is not None
        )
        if already and not force:
            results.append(
                {"index": index, "skipped": True, "answer": question.get("answer")}
            )
            continue
        outcome = solve_question(config, question, transport=transport)
        question.update(
            {
                "answer": outcome["answer"],
                "confidence": outcome["confidence"],
                "rawText": outcome.get("rawText"),
                "model": outcome["model"],
                "solvedAt": outcome["solvedAt"],
                "latencyMs": outcome["latencyMs"],
            }
        )
        solved += 1
        results.append({"index": index, "skipped": False, **{k: question[k] for k in
            ("answer", "confidence", "rawText", "model", "solvedAt", "latencyMs") if k in question}})
    if solved:
        record["questions"] = questions
        store.write(record)
    return {"solved": solved, "results": results}
