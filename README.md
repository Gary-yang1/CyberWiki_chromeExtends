# CyberWikiBench

CyberWikiBench 是一个带图形化界面、HTTP API 和模型 CLI runner 的本地网络安全知识评测工具。GUI、CLI 和后续 Chrome 插件使用同一套抽题与评分协议。

## 启动

在 PowerShell 中运行：

```powershell
.\start_benchmark.ps1
```

然后打开 <http://127.0.0.1:8765>。默认只监听本机地址，运行数据保存在 `data/benchmark_runs.sqlite3`。

也可以直接启动：

```powershell
python -m benchmark.server --host 127.0.0.1 --port 8765
```

## 图形化评测

界面支持：

- 选择单选题、判断题或混合题型。
- 设置题目数量、来源和可复现随机种子。
- 自动记录作答进度与耗时。
- 提交后自动评分，显示准确率、正确数、总用时、P95 延迟和逐题结果。
- 生成持久化的测试集 ID 与评分结果 ID。

## CLI 模型评测

CLI runner 支持任何提供 OpenAI-compatible `chat/completions` 接口的本地或外部模型。API Key 从环境变量读取，避免写入命令历史。

```powershell
$env:LLM_API_KEY = "your-key"
python scripts/run_model_benchmark.py `
  --benchmark-url http://127.0.0.1:8765 `
  --model-url https://your-provider.example/v1/chat/completions `
  --model your-model-name `
  --count 50 `
  --types single_choice,true_false `
  --parallel 4 `
  --seed 20260810 `
  --report runs/your-model-50.json
```

本地服务也使用相同命令，只需把 `--model-url` 改成本地兼容端点。CLI 会并行逐题调用模型、解析结构化答案、提交自动评分，并在终端输出摘要。

## HTTP API

API 的完整启动方式、PowerShell/curl/Python 示例、请求与响应字段、CLI 模型评测参数和 Chrome 插件接入流程见 [API 使用文档](docs/API.md)。

最短流程为：

1. `POST /api/v1/test-sets` 创建不含答案的测试集。
2. 将返回的 `questions` 交给模型或插件作答。
3. `POST /api/v1/submissions` 提交答案并获得自动评分。

## 主要文件

| 路径 | 用途 |
| --- | --- |
| `benchmark/server.py` | 本地 HTTP 与静态页面服务器。 |
| `benchmark/service.py` | 抽题、持久化和自动评分核心。 |
| `web/` | 图形化评测页面。 |
| `scripts/run_model_benchmark.py` | 大模型 CLI 自动评测器。 |
| `scripts/parse_question_bank.py` | 原始题库解析与 JSONL 校验。 |
| `data/questions.jsonl` | 规范题库源数据。 |
| `docs/API.md` | HTTP API 契约和 Chrome 插件接入说明。 |
| `docs/Chrome插件开发.md` | Chrome 插件加载、模型协议、本地 RAG 接口与 Benchmark 使用说明。 |
| `docs/题库数据标准.md` | 新增题目的标准格式。 |

## 测试

```powershell
python -m unittest discover -s tests -v
```

当前服务不依赖第三方 Python 包。正式跨设备部署前，应增加身份认证、来源白名单和 TLS；本地开发时保持默认的 `127.0.0.1` 监听地址。
