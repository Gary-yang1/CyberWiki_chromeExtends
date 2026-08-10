#!/usr/bin/env python3
"""Parse the source question bank and validate CyberWikiBench JSONL files.

Examples
--------
Parse the bundled source file:
    python scripts/parse_question_bank.py --input "题库汇总.txt" --out-dir data

Validate a manually added JSONL batch before merging it:
    python scripts/parse_question_bank.py --validate-jsonl data/incoming/new_questions.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1.0.0"
HEADER_PATTERN = re.compile(r"^\[(\d+)\]\s*\[(.*?)\]\s*$", re.MULTILINE)
QUESTION_PATTERN = re.compile(
    r"^题目:\s*(.*?)(?=\n(?:选项|题型):)", re.MULTILINE | re.DOTALL
)
ANSWER_PATTERN = re.compile(r"^正确选项:\s*(.*?)\s*$", re.MULTILINE)
TYPE_PATTERN = re.compile(r"^题型:\s*(.*?)\s*$", re.MULTILINE)
OPTION_PATTERN = re.compile(r"^  ([A-Z])\.\s", re.MULTILINE)
ANSWER_MARKER_PATTERN = re.compile(r"\s*←\s*正确答案\s*")
VALID_TYPES = {"single_choice", "true_false"}
VALID_QUALITY_STATUS = {"unreviewed", "verified", "questionable", "rejected"}


class ParseError(ValueError):
    """Raised when a source question cannot be converted safely."""


def clean_text(text: str) -> str:
    """Remove source-only answer markers and trailing whitespace, preserving layout."""

    text = ANSWER_MARKER_PATTERN.sub("", text)
    lines = [line.rstrip() for line in text.splitlines()]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def extract_options(block: str) -> list[dict[str, str]]:
    """Extract multi-line answer options without assuming dashed separators are delimiters."""

    options_heading = re.search(r"^选项:\s*$", block, re.MULTILINE)
    if not options_heading:
        return []

    answer_heading = re.search(r"^正确选项:\s*", block, re.MULTILINE)
    if not answer_heading:
        raise ParseError("选择题缺少“正确选项”行")

    options_area = block[options_heading.end() : answer_heading.start()]
    matches = list(OPTION_PATTERN.finditer(options_area))
    if not matches:
        raise ParseError("选择题未找到选项")

    result: list[dict[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(options_area)
        value = clean_text(options_area[match.end() : end])
        if not value:
            raise ParseError(f"选项 {match.group(1)} 内容为空")
        result.append({"key": match.group(1), "text": value})
    return result


def parse_source(source_path: Path) -> list[dict[str, Any]]:
    """Parse the legacy UTF-8 text format into the canonical question object format."""

    raw = source_path.read_text(encoding="utf-8-sig")
    headers = list(HEADER_PATTERN.finditer(raw))
    if not headers:
        raise ParseError("未找到形如 [1] [题库来源] 的题目头")

    questions: list[dict[str, Any]] = []
    for position, header in enumerate(headers):
        next_start = headers[position + 1].start() if position + 1 < len(headers) else len(raw)
        block = raw[header.start() : next_start]
        source_item_id = int(header.group(1))
        collection = header.group(2).strip()

        question_match = QUESTION_PATTERN.search(block)
        answer_match = ANSWER_PATTERN.search(block)
        type_match = TYPE_PATTERN.search(block)
        if not question_match or not answer_match:
            raise ParseError(f"第 {source_item_id} 题缺少题干或正确选项")

        stem = clean_text(question_match.group(1))
        raw_answer = answer_match.group(1).strip().upper()
        source_type = type_match.group(1).strip() if type_match else "选择题"
        if source_type == "判断题":
            question_type = "true_false"
            if raw_answer not in {"TRUE", "FALSE"}:
                raise ParseError(f"第 {source_item_id} 题的判断答案无效: {raw_answer}")
            answer: str | bool = raw_answer == "TRUE"
            options: list[dict[str, str]] = []
        else:
            question_type = "single_choice"
            options = extract_options(block)
            option_keys = [item["key"] for item in options]
            if raw_answer not in option_keys:
                raise ParseError(
                    f"第 {source_item_id} 题答案 {raw_answer} 不在选项 {option_keys} 中"
                )
            answer = raw_answer

        question: dict[str, Any] = {
            "id": f"cwkb-{source_item_id:04d}",
            "type": question_type,
            "stem": stem,
            "options": options,
            "answer": answer,
            "source": {
                "collection": collection,
                "source_item_id": source_item_id,
                "reference": source_path.name,
            },
            "metadata": {
                "domain": None,
                "subdomain": None,
                "difficulty": None,
                "reasoning_types": [],
                "tags": [],
                "version": None,
                "quality_status": "unreviewed",
            },
            "explanation": None,
            "evidence": [],
        }
        validation_errors = validate_question(question, context=f"第 {source_item_id} 题")
        if validation_errors:
            raise ParseError("；".join(validation_errors))
        questions.append(question)

    ids = [question["id"] for question in questions]
    if len(ids) != len(set(ids)):
        raise ParseError("生成了重复的题目 ID")
    return questions


def validate_question(question: Any, context: str = "题目") -> list[str]:
    """Return validation errors for one canonical question object."""

    errors: list[str] = []
    if not isinstance(question, dict):
        return [f"{context}: 必须是 JSON 对象"]

    required = {"id", "type", "stem", "options", "answer", "source", "metadata", "explanation", "evidence"}
    missing = sorted(required - set(question))
    if missing:
        errors.append(f"{context}: 缺少字段 {', '.join(missing)}")
        return errors

    question_id = question["id"]
    if not isinstance(question_id, str) or not re.fullmatch(r"[a-z][a-z0-9-]*", question_id):
        errors.append(f"{context}: id 必须是小写字母开头的稳定 slug")
    question_type = question["type"]
    if question_type not in VALID_TYPES:
        errors.append(f"{context}: type 必须为 {sorted(VALID_TYPES)} 之一")
    if not isinstance(question["stem"], str) or not question["stem"].strip():
        errors.append(f"{context}: stem 不能为空字符串")

    leaked_fields = [question.get("stem", "")]
    leaked_fields.extend(option.get("text", "") for option in question.get("options", []) if isinstance(option, dict))
    if any("正确答案" in value or "←" in value for value in leaked_fields if isinstance(value, str)):
        errors.append(f"{context}: 题干或选项含答案泄漏标记")

    options = question["options"]
    if not isinstance(options, list):
        errors.append(f"{context}: options 必须是数组")
        options = []
    if question_type == "single_choice":
        if not 2 <= len(options) <= 6:
            errors.append(f"{context}: single_choice 必须有 2 至 6 个选项")
        keys: list[str] = []
        for option in options:
            if not isinstance(option, dict) or set(option) != {"key", "text"}:
                errors.append(f"{context}: 每个 option 必须只含 key 和 text")
                continue
            key, text = option["key"], option["text"]
            keys.append(key)
            if not isinstance(key, str) or not re.fullmatch(r"[A-Z]", key):
                errors.append(f"{context}: 选项 key 必须是单个大写字母")
            if not isinstance(text, str) or not text.strip():
                errors.append(f"{context}: 选项文本不能为空")
        if len(keys) != len(set(keys)):
            errors.append(f"{context}: 选项 key 重复")
        if question["answer"] not in keys:
            errors.append(f"{context}: answer 必须是现有选项 key")
    elif question_type == "true_false":
        if options:
            errors.append(f"{context}: true_false 的 options 必须为空数组")
        if not isinstance(question["answer"], bool):
            errors.append(f"{context}: true_false 的 answer 必须为 true 或 false")

    source = question["source"]
    if not isinstance(source, dict):
        errors.append(f"{context}: source 必须是对象")
    else:
        for field in ("collection", "reference"):
            if not isinstance(source.get(field), str) or not source[field].strip():
                errors.append(f"{context}: source.{field} 必须是非空字符串")
        if not isinstance(source.get("source_item_id"), int) or source["source_item_id"] < 1:
            errors.append(f"{context}: source.source_item_id 必须是正整数")

    metadata = question["metadata"]
    if not isinstance(metadata, dict):
        errors.append(f"{context}: metadata 必须是对象")
    elif metadata.get("quality_status") not in VALID_QUALITY_STATUS:
        errors.append(f"{context}: metadata.quality_status 无效")
    if not isinstance(question["evidence"], list):
        errors.append(f"{context}: evidence 必须是数组")
    return errors


def validate_jsonl(path: Path) -> int:
    """Validate an independently authored JSONL file and print all errors."""

    errors: list[str] = []
    seen_ids: set[str] = set()
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            question = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"第 {number} 行: JSON 无法解析: {exc.msg}")
            continue
        errors.extend(validate_question(question, context=f"第 {number} 行"))
        question_id = question.get("id") if isinstance(question, dict) else None
        if question_id in seen_ids:
            errors.append(f"第 {number} 行: id {question_id} 与前面重复")
        elif isinstance(question_id, str):
            seen_ids.add(question_id)
    if errors:
        print("验证失败：")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print(f"验证通过：{path}（{len(seen_ids)} 题）")
    return 0


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Load and validate a canonical JSONL file for aggregate-output generation."""

    questions: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    errors: list[str] = []
    for number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            question = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"第 {number} 行: JSON 无法解析: {exc.msg}")
            continue
        errors.extend(validate_question(question, context=f"第 {number} 行"))
        question_id = question.get("id") if isinstance(question, dict) else None
        if question_id in seen_ids:
            errors.append(f"第 {number} 行: id {question_id} 与前面重复")
        elif isinstance(question_id, str):
            seen_ids.add(question_id)
        if isinstance(question, dict):
            questions.append(question)
    if errors:
        raise ParseError("JSONL 校验失败：\n" + "\n".join(errors))
    return questions


def write_outputs(questions: list[dict[str, Any]], source_path: Path, out_dir: Path) -> None:
    """Write the append-friendly JSONL, aggregate JSON, and deterministic parse report."""

    out_dir.mkdir(parents=True, exist_ok=True)
    source_digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
    type_counts = Counter(question["type"] for question in questions)
    answer_counts = Counter(
        str(question["answer"]).lower() if isinstance(question["answer"], bool) else question["answer"]
        for question in questions
    )
    source_counts = Counter(question["source"]["collection"] for question in questions)

    jsonl_path = out_dir / "questions.jsonl"
    jsonl_path.write_text(
        "".join(json.dumps(question, ensure_ascii=False, separators=(",", ":")) + "\n" for question in questions),
        encoding="utf-8",
    )

    dataset = {
        "schema_version": SCHEMA_VERSION,
        "dataset": {
            "name": "CyberWikiBench Question Bank",
            "source_file": source_path.name,
            "source_sha256": source_digest,
            "question_count": len(questions),
        },
        "questions": questions,
    }
    (out_dir / "questions.json").write_text(
        json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    report = {
        "schema_version": SCHEMA_VERSION,
        "source_file": source_path.name,
        "source_sha256": source_digest,
        "question_count": len(questions),
        "type_counts": dict(sorted(type_counts.items())),
        "answer_counts": dict(sorted(answer_counts.items())),
        "source_counts": dict(sorted(source_counts.items())),
        "validation": {"valid_questions": len(questions), "invalid_questions": 0},
    }
    (out_dir / "parse_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path("题库汇总.txt"), help="原始 TXT 题库")
    parser.add_argument("--out-dir", type=Path, default=Path("data"), help="输出目录")
    parser.add_argument("--validate-jsonl", type=Path, help="只验证手工维护的 JSONL 文件")
    parser.add_argument("--build-jsonl", type=Path, help="验证 JSONL 并重建聚合 JSON 与报告")
    args = parser.parse_args()

    if args.validate_jsonl:
        return validate_jsonl(args.validate_jsonl)
    try:
        if args.build_jsonl:
            questions = load_jsonl(args.build_jsonl)
            write_outputs(questions, args.build_jsonl, args.out_dir)
            print(f"构建完成：{len(questions)} 题 -> {args.out_dir}")
            return 0
        questions = parse_source(args.input)
        write_outputs(questions, args.input, args.out_dir)
    except (OSError, ParseError) as exc:
        print(f"解析失败：{exc}", file=sys.stderr)
        return 1
    print(f"解析完成：{len(questions)} 题 -> {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
