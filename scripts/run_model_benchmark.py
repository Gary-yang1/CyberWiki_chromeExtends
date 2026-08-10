#!/usr/bin/env python3
"""Run an OpenAI-compatible chat model against the CyberWikiBench API."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


DEFAULT_SYSTEM_PROMPT = (
    "你正在参加网络安全知识选择题测试。只输出严格 JSON，不要解释。"
    "单选题格式为 {\"answer\":\"A\"}；判断题格式为 {\"answer\":true}。"
)


class HTTPClientError(RuntimeError):
    pass


def request_json(
    url: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 120,
) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        response_text = exc.read().decode("utf-8", errors="replace")
        raise HTTPClientError(f"HTTP {exc.code} {url}: {response_text}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise HTTPClientError(f"请求 {url} 失败: {exc}") from exc


def format_question(question: dict[str, Any]) -> str:
    if question["type"] == "true_false":
        return f"题型：判断题\n题目：{question['stem']}\n请判断 true 或 false。"
    option_text = "\n".join(
        f"{option['key']}. {option['text']}" for option in question["options"]
    )
    return f"题型：单选题\n题目：{question['stem']}\n选项：\n{option_text}"


def extract_content(response: dict[str, Any]) -> str:
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("模型响应不含 choices[0].message.content") from exc
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        texts = [part.get("text", "") for part in content if isinstance(part, dict)]
        return "".join(texts).strip()
    raise ValueError("模型响应 content 类型无效")


def parse_model_answer(content: str, question_type: str) -> str | bool | None:
    cleaned = content.strip()
    try:
        parsed = json.loads(cleaned)
        value = parsed.get("answer") if isinstance(parsed, dict) else parsed
        if question_type == "true_false":
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in {"true", "正确", "对"}:
                    return True
                if lowered in {"false", "错误", "错"}:
                    return False
        elif isinstance(value, str) and re.fullmatch(r"[A-Fa-f]", value.strip()):
            return value.strip().upper()
    except json.JSONDecodeError:
        pass

    if question_type == "true_false":
        matches = re.findall(r"(?i)\b(true|false)\b|(?<!不)(正确|错误|对|错)", cleaned)
        flattened = [next(part for part in match if part) for match in matches]
        if flattened:
            return flattened[-1].lower() in {"true", "正确", "对"}
        return None
    matches = re.findall(r"(?i)(?:answer|答案|选项)?\s*[:：]?\s*\b([A-F])\b", cleaned)
    return matches[-1].upper() if matches else None


def call_model(
    model_url: str,
    model: str,
    api_key: str | None,
    system_prompt: str,
    question: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    started = time.perf_counter()
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    raw_output = ""
    try:
        response = request_json(
            model_url,
            method="POST",
            payload={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": format_question(question)},
                ],
                "temperature": 0,
                "max_tokens": 64,
            },
            headers=headers,
            timeout=timeout,
        )
        raw_output = extract_content(response)
        answer = parse_model_answer(raw_output, question["type"])
    except Exception as exc:  # preserve failed calls as unanswered benchmark rows
        answer = None
        raw_output = f"ERROR: {exc}"
    latency_ms = round((time.perf_counter() - started) * 1000, 3)
    return {
        "question_id": question["id"],
        "answer": answer,
        "latency_ms": latency_ms,
        "raw_output": raw_output,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark-url", default="http://127.0.0.1:8765")
    parser.add_argument("--model-url", required=True, help="完整的 OpenAI-compatible chat/completions URL")
    parser.add_argument("--model", required=True)
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument(
        "--types",
        default="single_choice,true_false",
        help="逗号分隔：single_choice,true_false",
    )
    parser.add_argument("--source", action="append", default=[], help="按来源筛选，可重复")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--parallel", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--api-key-env", default="LLM_API_KEY")
    parser.add_argument("--system-prompt", default=DEFAULT_SYSTEM_PROMPT)
    parser.add_argument("--report", type=Path, help="另存完整评分 JSON")
    args = parser.parse_args()

    if args.count < 1 or args.parallel < 1:
        parser.error("--count 和 --parallel 必须大于 0")
    types = [value.strip() for value in args.types.split(",") if value.strip()]
    set_payload: dict[str, Any] = {
        "types": types,
        "sources": args.source,
        "count": args.count,
    }
    if args.seed is not None:
        set_payload["seed"] = args.seed

    benchmark_url = args.benchmark_url.rstrip("/")
    try:
        test_set = request_json(
            f"{benchmark_url}/api/v1/test-sets", method="POST", payload=set_payload
        )
    except HTTPClientError as exc:
        print(exc, file=sys.stderr)
        return 1

    print(
        f"测试集 {test_set['id']}：{len(test_set['questions'])} 题，seed={test_set['config']['seed']}",
        file=sys.stderr,
    )
    api_key = os.environ.get(args.api_key_env) or None
    answers: list[dict[str, Any]] = []
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.parallel) as executor:
        futures = {
            executor.submit(
                call_model,
                args.model_url,
                args.model,
                api_key,
                args.system_prompt,
                question,
                args.timeout,
            ): question
            for question in test_set["questions"]
        }
        completed = 0
        for future in as_completed(futures):
            answers.append(future.result())
            completed += 1
            print(f"已完成 {completed}/{len(futures)}", file=sys.stderr)
    total_latency_ms = round((time.perf_counter() - started) * 1000, 3)
    order = {question["id"]: index for index, question in enumerate(test_set["questions"])}
    answers.sort(key=lambda item: order[item["question_id"]])

    try:
        result = request_json(
            f"{benchmark_url}/api/v1/submissions",
            method="POST",
            payload={
                "test_set_id": test_set["id"],
                "answers": answers,
                "total_latency_ms": total_latency_ms,
                "client": {
                    "kind": "cli-model-runner",
                    "model": args.model,
                    "model_url": args.model_url,
                    "parallel": args.parallel,
                },
            },
        )
    except HTTPClientError as exc:
        print(exc, file=sys.stderr)
        return 1

    summary_output = {
        "submission_id": result["id"],
        "test_set_id": result["test_set_id"],
        "model": args.model,
        "summary": result["summary"],
    }
    print(json.dumps(summary_output, ensure_ascii=False, indent=2))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"完整报告已写入 {args.report}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
