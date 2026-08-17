import assert from "node:assert/strict";
import test from "node:test";

await import("../content/question-heuristics.js");

const heuristics = globalThis.__CWKB_QUESTION_HEURISTICS_V1__;

test("parses common letter and number option prefixes without matching marker-only text", () => {
  assert.deepEqual(heuristics.parseOptionText("A. Alpha"), { key: "A", text: "Alpha" });
  assert.deepEqual(heuristics.parseOptionText("（B）Beta"), { key: "B", text: "Beta" });
  assert.deepEqual(heuristics.parseOptionText("3、Gamma"), { key: "3", text: "Gamma" });
  assert.deepEqual(heuristics.parseOptionText("D Delta"), { key: "D", text: "Delta" });
  assert.equal(heuristics.parseOptionText("A."), null);
  // A single "A ..." line is only a weak candidate; the DOM extractor still
  // requires a complete sequential group before accepting it as a question.
  assert.equal(heuristics.parseOptionText("Alpha is a normal sentence"), null);
});

test("recognizes sequential option keys and splits repeated ABCD runs", () => {
  assert.equal(heuristics.keySequenceKind(["A", "B", "C", "D"]), "letters");
  assert.equal(heuristics.keySequenceKind(["1", "2", "3"]), "numbers");
  assert.equal(heuristics.keySequenceKind(["A", "C", "D"]), "");
  const runs = heuristics.splitSequentialRuns([
    { key: "A" }, { key: "B" }, { key: "C" },
    { key: "A" }, { key: "B" },
  ]);
  assert.deepEqual(runs.map((run) => run.map((item) => item.key)), [["A", "B", "C"], ["A", "B"]]);
});

test("infers single, multiple, true-false, and unknown choice types from independent signals", () => {
  const ordinaryOptions = [{ key: "A", text: "one" }, { key: "B", text: "two" }];
  assert.equal(heuristics.inferQuestionType({ options: ordinaryOptions, controlKinds: ["radio"] }), "single_choice");
  assert.equal(heuristics.inferQuestionType({ options: ordinaryOptions, controlKinds: ["checkbox"] }), "multiple_choice");
  assert.equal(heuristics.inferQuestionType({ options: ordinaryOptions, rootText: "请选择所有正确选项" }), "multiple_choice");
  assert.equal(heuristics.inferQuestionType({ options: ordinaryOptions }), "choice_unknown");
  assert.equal(heuristics.inferQuestionType({
    options: [{ key: "A", text: "正确" }, { key: "B", text: "错误" }],
    controlKinds: ["radio"],
  }), "true_false");
  assert.equal(heuristics.inferQuestionType({
    options: [{ key: "1", text: "Linux" }, { key: "0", text: "Windows" }],
    controlKinds: ["radio"],
  }), "single_choice");
});

test("requires multiple independent signals before accepting text-only candidates", () => {
  const accepted = heuristics.scoreQuestionCandidate({
    optionCount: 4,
    hasStem: true,
    stemLength: 30,
    sequentialKeys: true,
  });
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.confidence >= 0.52);

  const rejected = heuristics.scoreQuestionCandidate({
    optionCount: 2,
    hasStem: false,
    sequentialKeys: false,
  });
  assert.equal(rejected.accepted, false);
});

test("treats value attributes as option keys only when key-shaped", () => {
  // Element Plus sets value to the full label; that must NOT become the key.
  assert.equal(heuristics.optionKeyLikeValue("使用专线传输"), "");
  assert.equal(heuristics.optionKeyLikeValue("对传输数据进行加密"), "");
  assert.equal(heuristics.optionKeyLikeValue(""), "");
  // Classic shapes stay usable as keys.
  assert.equal(heuristics.optionKeyLikeValue("A"), "A");
  assert.equal(heuristics.optionKeyLikeValue("b"), "B");
  assert.equal(heuristics.optionKeyLikeValue("3"), "3");
  assert.equal(heuristics.optionKeyLikeValue("(B)"), "B");
  assert.equal(heuristics.optionKeyLikeValue(" true "), "true");
  assert.equal(heuristics.optionKeyLikeValue("正确"), "正确");
});
