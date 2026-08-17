# CyberWikiBench HTTP API

本文档既是 API 契约，也是可直接执行的接入手册。完整评测流程只有三步：创建测试集、让模型回答、提交答案评分。

```text
POST /test-sets  →  questions（不含答案）
                         ↓
                   模型/插件作答
                         ↓
POST /submissions →  summary + details（含评分）
```

## 约定

- 默认地址：`http://127.0.0.1:8765`
- API 版本前缀：`/api/v1`
- 请求和响应：UTF-8 JSON
- 测试集接口绝不返回 `answer`、`explanation` 或 `evidence`。
- 提交评分后，评分结果会返回标准答案和逐题状态。
- 默认允许跨域请求，供本地 Chrome 扩展调用；服务默认只监听回环地址。
- 测试集和评分结果持久化在 `data/benchmark_runs.sqlite3`，服务重启后仍可按 ID 读取。

## 接口一览

| 方法 | 路径 | 用途 | 成功状态 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/health` | 检查服务是否启动。 | `200` |
| `GET` | `/api/v1/stats` | 获取题型、来源和领域统计。 | `200` |
| `POST` | `/api/v1/test-sets` | 按条件抽题并创建固定测试集。 | `201` |
| `GET` | `/api/v1/test-sets/{id}` | 恢复已经创建的测试集。 | `200` |
| `POST` | `/api/v1/submissions` | 提交模型/用户答案并自动评分。 | `201` |
| `GET` | `/api/v1/submissions/{id}` | 获取已经保存的完整评分结果。 | `200` |

## 五分钟快速开始

### 1. 启动服务

在项目根目录运行：

```powershell
.\start_benchmark.ps1
```

Linux / macOS：

```bash
./start_benchmark.sh
```

保持这个终端窗口运行，再打开另一个 PowerShell 窗口调用 API。

### 2. 检查服务和题库

```powershell
$apiBase = "http://127.0.0.1:8765/api/v1"
Invoke-RestMethod -Uri "$apiBase/health"
Invoke-RestMethod -Uri "$apiBase/stats"
```

### 3. 创建一个固定的三题测试集

```powershell
$createBody = @{
    types   = @("single_choice", "true_false")
    count   = 3
    sources = @()
    domains = @()
    seed    = 20260810
} | ConvertTo-Json

$testSet = Invoke-RestMethod `
    -Uri "$apiBase/test-sets" `
    -Method Post `
    -ContentType "application/json" `
    -Body $createBody

$testSet.id
$testSet.questions | Format-List index,id,type,stem,options
```

`$testSet.questions` 不包含标准答案。保存 `$testSet.id`，提交评分时需要使用它。

### 4. 提交示例答案并自动评分

下面的示例对单选题统一回答 `A`，判断题统一回答 `true`，用于验证流程。真实模型接入时，把这里替换成模型输出。

```powershell
$answers = @(
    foreach ($question in $testSet.questions) {
        @{
            question_id = $question.id
            answer       = if ($question.type -eq "true_false") { $true } else { "A" }
            latency_ms   = 500
            raw_output   = "smoke-test"
        }
    }
)

$submitBody = @{
    test_set_id     = $testSet.id
    answers         = $answers
    total_latency_ms = 1500
    client          = @{
        kind = "powershell-smoke-test"
        name = "manual-api-test"
    }
} | ConvertTo-Json -Depth 8

$result = Invoke-RestMethod `
    -Uri "$apiBase/submissions" `
    -Method Post `
    -ContentType "application/json" `
    -Body $submitBody

$result.summary | Format-List
$result.details | Format-Table index,question_id,submitted_answer,correct_answer,is_correct
```

### 5. 重新读取结果

```powershell
$savedResult = Invoke-RestMethod -Uri "$apiBase/submissions/$($result.id)"
$savedResult.summary
```

## curl.exe 示例

Windows PowerShell 中的 `curl` 可能是 `Invoke-WebRequest` 的别名，建议明确使用 `curl.exe`：

```powershell
curl.exe http://127.0.0.1:8765/api/v1/health

curl.exe -X POST http://127.0.0.1:8765/api/v1/test-sets `
  -H "Content-Type: application/json" `
  -d '{"types":["single_choice"],"count":5,"sources":[],"domains":[],"seed":42}'
```

在 Bash、zsh 等终端中，将 PowerShell 的续行符反引号替换为反斜杠 `\`。

错误格式：

```json
{
  "error": {
    "code": "invalid_count",
    "message": "count 必须在 1 到 1000 之间"
  }
}
```

## 健康检查

`GET /api/v1/health`

```json
{
  "status": "ok",
  "service": "CyberWikiBench",
  "version": "0.1.0"
}
```

## 题库统计

`GET /api/v1/stats`

返回总题数、题型、来源和领域分布。GUI 可以据此生成筛选控件。

当前响应示例：

```json
{
  "question_count": 931,
  "type_counts": {
    "single_choice": 776,
    "true_false": 155
  },
  "source_counts": {
    "网管四级练习题（一）": 180
  },
  "domain_counts": {
    "unlabeled": 931
  }
}
```

## 创建测试集

`POST /api/v1/test-sets`

```json
{
  "types": ["single_choice", "true_false"],
  "count": 20,
  "sources": [],
  "domains": [],
  "seed": 20260810
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `types` | 否 | 默认包含 `single_choice` 和 `true_false`。 |
| `count` | 否 | 默认 20，范围 1～1000，且不能超过筛选后的题数。 |
| `sources` | 否 | 来源名称数组；空数组表示全部。 |
| `domains` | 否 | 领域数组；空数组表示全部。未标注领域使用 `unlabeled`。 |
| `seed` | 否 | 整数；相同题库、筛选条件和种子得到相同题目顺序。 |

注意：相同筛选条件、题库版本和 `seed` 会得到相同的题目及顺序，但每次创建仍会产生新的测试集 ID。需要完全复用同一测试集时，应保存并使用原测试集 ID。

响应状态为 `201 Created`：

```json
{
  "id": "set-...",
  "created_at": "2026-08-10T00:00:00+00:00",
  "config": {
    "types": ["single_choice"],
    "sources": [],
    "domains": [],
    "count": 2,
    "seed": 20260810
  },
  "questions": [
    {
      "index": 1,
      "id": "cwkb-0001",
      "type": "single_choice",
      "stem": "...",
      "options": [
        {"key": "A", "text": "..."},
        {"key": "B", "text": "..."}
      ],
      "source": {"collection": "..."},
      "metadata": {
        "domain": null,
        "subdomain": null,
        "difficulty": null,
        "tags": []
      }
    }
  ]
}
```

## 读取测试集

`GET /api/v1/test-sets/{test_set_id}`

用于 CLI 或 Chrome 插件恢复尚未提交的测试集。返回内容仍不含答案。

```powershell
$testSetId = "set-替换成实际ID"
Invoke-RestMethod -Uri "$apiBase/test-sets/$testSetId"
```

## 提交并自动评分

`POST /api/v1/submissions`

```json
{
  "test_set_id": "set-...",
  "answers": [
    {
      "question_id": "cwkb-0001",
      "answer": "B",
      "latency_ms": 842.5,
      "raw_output": "{\"answer\":\"B\"}"
    },
    {
      "question_id": "cwkb-0010",
      "answer": false,
      "latency_ms": 511.2
    }
  ],
  "total_latency_ms": 1500,
  "client": {
    "kind": "chrome-extension",
    "version": "0.1.0",
    "model": "local-model"
  }
}
```

未提交的题目按未作答和错误处理。单选答案使用大写选项键；判断题推荐使用 JSON boolean，也兼容 `true/false`、`正确/错误` 等文本。重复题目或不属于当前测试集的题目会被拒绝。

单题答案字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `question_id` | 是 | 必须属于当前测试集。 |
| `answer` | 否 | 单选题为 `"A"`～`"F"`；判断题为 `true/false`。缺失或无法解析时按未作答处理。 |
| `latency_ms` | 否 | 单题端到端耗时，非负毫秒数。用于计算 mean、p50 和 p95。 |
| `raw_output` | 否 | 模型原始输出，便于排查格式错误；不参与主评分。 |

顶层字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `test_set_id` | 是 | 创建测试集时返回的 ID。 |
| `answers` | 否 | 答案数组；省略等价于全部未作答。 |
| `total_latency_ms` | 否 | 整轮评测的墙钟时间；并行测试时不要使用单题耗时之和。 |
| `client` | 否 | 任意客户端元信息，例如模型、版本、提示词版本和并发数。 |

响应状态为 `201 Created`，包括：

- `summary.total/answered/correct/accuracy`
- 端到端 `total_latency_ms`
- 单题延迟 `mean_ms/p50_ms/p95_ms`
- `summary.by_type` 分类成绩
- `details` 中的逐题答案、标准答案、是否正确、原始模型输出、解析与证据

评分结果示例：

```json
{
  "id": "submission-...",
  "test_set_id": "set-...",
  "summary": {
    "total": 20,
    "answered": 20,
    "correct": 16,
    "accuracy": 0.8,
    "total_latency_ms": 12600,
    "latency": {
      "count": 20,
      "mean_ms": 1820.4,
      "p50_ms": 1701.2,
      "p95_ms": 2902.6
    },
    "by_type": {
      "single_choice": {"total": 16, "correct": 13, "accuracy": 0.8125},
      "true_false": {"total": 4, "correct": 3, "accuracy": 0.75}
    }
  },
  "details": []
}
```

`accuracy` 的范围是 `0.0`～`1.0`，不是百分数。CLI 或界面显示时可以乘以 100。

## 读取评分结果

`GET /api/v1/submissions/{submission_id}`

返回持久化的完整评分结果，可用于结果页面、CLI 报告和模型横向比较。

## 使用内置 CLI 直接测试模型

内置 runner 会自动完成创建测试集、调用模型、解析答案和提交评分。它支持任何 OpenAI-compatible `chat/completions` 端点。

如果全局 `python` 命令不可用，可以使用 Codex 桌面环境附带的解释器：

```powershell
$benchmarkPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$env:LLM_API_KEY = "your-api-key"

& $benchmarkPython scripts/run_model_benchmark.py `
  --benchmark-url http://127.0.0.1:8765 `
  --model-url https://your-provider.example/v1/chat/completions `
  --model your-model-name `
  --count 50 `
  --types single_choice,true_false `
  --parallel 4 `
  --seed 20260810 `
  --report runs/your-model-50.json
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--benchmark-url` | Benchmark 服务地址。 |
| `--model-url` | 完整的 OpenAI-compatible `/chat/completions` 地址。 |
| `--model` | 传给模型服务的模型名。 |
| `--count` | 抽取题目数量。 |
| `--types` | 逗号分隔的题型。 |
| `--source` | 来源筛选；可以重复提供。 |
| `--seed` | 固定抽题结果。 |
| `--parallel` | 并发模型请求数。 |
| `--api-key-env` | 保存 API Key 的环境变量名，默认 `LLM_API_KEY`。 |
| `--report` | 保存完整评分 JSON 的路径。 |

模型输出应尽量采用：

```json
{"answer": "B"}
```

或判断题：

```json
{"answer": true}
```

runner 对常见纯文本输出有容错，但无法解析的结果会作为未作答，不会中断整轮评测。

## Python 标准库调用示例

以下示例无需安装 `requests`：

```python
import json
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:8765/api/v1"

def call(path, method="GET", payload=None):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        BASE + path,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))

test_set = call("/test-sets", "POST", {
    "types": ["single_choice", "true_false"],
    "count": 10,
    "seed": 42,
})

# 在这里把 test_set["questions"] 交给模型，并生成 answers。
answers = []

result = call("/submissions", "POST", {
    "test_set_id": test_set["id"],
    "answers": answers,
    "client": {"kind": "python-client", "model": "example-model"},
})
print(result["summary"])
```

## Chrome 插件推荐流程

1. 在 Benchmark 页面或扩展配置中创建测试集。
2. 扩展逐题读取 `questions`，在目标网页调用答题逻辑。
3. 保存模型原始输出、解析答案和每题延迟。
4. 完成后调用 `/api/v1/submissions`。
5. 使用返回的 `summary` 和 `details` 展示成绩与错误分析。

扩展 Service Worker 中的最小请求示例：

```javascript
const response = await fetch("http://127.0.0.1:8765/api/v1/test-sets", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    types: ["single_choice", "true_false"],
    count: 20,
    seed: 42,
  }),
});

if (!response.ok) {
  const error = await response.json();
  throw new Error(error.error?.message || `HTTP ${response.status}`);
}

const testSet = await response.json();
```

Chrome 扩展的 Manifest 需要允许访问本地 API：

```json
{
  "host_permissions": ["http://127.0.0.1:8765/*"]
}
```

## HTTP 状态码与错误处理

| 状态码 | 含义 | 常见原因 |
| --- | --- | --- |
| `200` | 查询成功 | 健康检查、统计或读取已有记录。 |
| `201` | 创建成功 | 测试集或提交记录已创建。 |
| `400` | 请求参数错误 | 数量超出范围、题型无效、重复答案、题目不属于测试集。 |
| `404` | 记录不存在 | 测试集 ID 或提交 ID 错误。 |
| `415` | Content-Type 错误 | POST 请求没有使用 `application/json`。 |
| `500` | 服务内部错误 | 查看服务终端日志。 |

客户端应首先判断 HTTP 状态码，再读取 `error.code` 和 `error.message`。不要根据中文错误文本编写程序分支；应使用稳定的 `error.code`。

## 可复现评测建议

- 固定题库文件、`types`、`sources`、`domains` 和 `seed`。
- 记录返回的 `test_set_id`，多个模型应读取同一个测试集 ID，而不是分别重新抽题。
- 在 `client` 中保存模型名、模型版本、量化方式、提示词版本、并发数和运行环境。
- 同时报告准确率、整轮耗时、单题 p50/p95；并行运行时特别关注 `total_latency_ms`。
- 不要把测试集的评分 `details` 或标准答案再次放入模型上下文。

正式发布扩展时，应在 API 服务中增加固定 Token、限制允许的扩展 Origin，并避免将服务绑定到 `0.0.0.0`。

## 题库采集服务（端口 8790）

题库采集服务（`./start_collector.sh`，默认 `http://127.0.0.1:8790`）与 benchmark 服务相互独立，接收 Chrome 插件的一键采集，并在 `/` 提供移动端题库界面。数据目录为 `data/extractions/`（每次提取一个 JSON 文件，git 忽略）。

### 多用户鉴权（可选）

创建 `data/collector_auth.json` 即启用按用户隔离：

```json
{ "users": { "gary": "key-gary-xxxx", "alice": "key-alice-yyyy" } }
```

- 启用后，**所有** `/api/v1` 请求必须携带 `X-User-Id` 与 `X-Api-Key` 请求头，key 需与该用户的配置匹配，否则返回 `401 {"error":{"code":"unauthorized"}}`。
- 采集内容按用户分目录：`data/extractions/<userId>/`；每个用户只能列出、读取、检索、解答自己空间内的题目。
- User ID 限 1–32 位字母/数字/下划线/连字符（防路径穿越）。
- 未创建该文件（或 users 为空）时为开放模式：无需凭据，所有数据在共享的 `default` 空间。
- 移动端 UI 在启用鉴权时显示登录页（凭据保存在浏览器 localStorage），可退出登录；插件侧边栏「题库采集」小节填写同样的 User ID/Key。

### 接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/health` | 健康检查（启用鉴权时一并校验凭据，返回 `user`）。 |
| `GET` | `/api/v1/stats` | 提取次数、题目总数、已解答数。 |
| `GET` | `/api/v1/search?q=&limit=` | 按题干/选项/答案关键词检索，返回题目级命中（含 `extractionId` 与 `questionIndex` 用于定位）。 |
| `POST` | `/api/v1/extractions` | 保存一次页面提取。 |
| `GET` | `/api/v1/extractions?limit=&offset=` | 分页列出提取记录摘要（新在前）。 |
| `GET` | `/api/v1/extractions/{id}` | 读取一条完整提取记录（含题目与答案）。 |
| `POST` | `/api/v1/solve` | 调用已配置的模型解答题目并把答案写回文件。 |
| `GET` / `PUT` | `/api/v1/model-config` | 读取（掩码）/保存服务端模型配置。 |
| `POST` | `/api/v1/model-config/test` | 用当前配置发送最小测试请求。 |

### 保存一次提取

```bash
curl -X POST http://127.0.0.1:8790/api/v1/extractions \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://quiz.example/page",
    "title": "示例页面",
    "extractedAt": "2026-08-17T10:00:00.000Z",
    "questions": [
      { "id": "q1", "type": "single_choice", "stem": "1+1=?", "options": { "A": "1", "B": "2" } }
    ]
  }'
```

响应 `201`：

```json
{
  "saved": true,
  "extraction": { "id": "20260817T100000Z-abcd1234", "questionCount": 1, "contentHash": "abcd1234ef567890" }
}
```

校验规则：`questions` 必须是非空数组，每项必须包含非空 `stem` 字符串；单次最多 500 题。同一内容重复提交会各自保存（保留全部），`contentHash` 供后续工具去重。

### AI 解答

先在移动端 UI 的「设置」页（或 `PUT /api/v1/model-config`）配置 OpenAI 兼容接口、API Key 与模型 ID（例如 `https://api.deepseek.com/v1` + `deepseek-chat`）。密钥只保存在本机 `data/collector_config.json`，读取接口只返回掩码。

```bash
curl -X POST http://127.0.0.1:8790/api/v1/solve \
  -H "Content-Type: application/json" \
  -d '{ "extractionId": "20260817T100000Z-abcd1234", "questionIndexes": [0] }'
```

- `questionIndexes` 省略或为 `null`：解答该次提取中所有未解题目。
- `force: true`：重新解答（默认跳过已有答案的题目）。
- 答案、置信度、模型名、耗时会写回 `data/extractions/<id>.json` 中对应题目的 `answer` 等字段。
- 模型输出无法解析为 JSON 时保留 `rawText`，`answer` 为 `null`，不会报错。

### Chrome 插件一键采集

1. 运行 `./start_collector.sh`。
2. 插件侧边栏「答题设置 → 题库采集」开启开关（Endpoint 默认 `http://127.0.0.1:8790/api/v1/extractions`）。
3. 在已授权的题目页面按 **Alt / ⌥ + Shift + C**：提取当前页全部题目并发送。工具栏图标反馈：绿色 `✓`（成功）/ 黄色 `?`（未识别到题目）/ 红色 `!`（网络或服务错误）。
