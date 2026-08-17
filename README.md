# CyberWikiBench

CyberWikiBench 是一个带图形化界面、HTTP API 和模型 CLI runner 的本地网络安全知识评测工具。GUI、CLI 和后续 Chrome 插件使用同一套抽题与评分协议。

## 启动

Windows PowerShell：

```powershell
.\start_benchmark.ps1
```

Linux / macOS：

```bash
./start_benchmark.sh
```

两个脚本都支持自定义监听地址和端口：PowerShell 使用 `-HostAddress 0.0.0.0 -Port 9000`；Bash 使用 `--host 0.0.0.0 --port 9000`。Linux 脚本优先使用 `$PYTHON`、Codex bundled Python，随后尝试 `python3` 和 `python`。

然后打开 <http://127.0.0.1:8765>。默认只监听本机地址，运行数据保存在 `data/benchmark_runs.sqlite3`。

也可以直接启动：

```powershell
python -m benchmark.server --host 127.0.0.1 --port 8765
```

## 题库采集服务

配套的题库采集服务独立运行在 `127.0.0.1:8790`，与 benchmark 服务互不依赖：

```bash
./start_collector.sh            # macOS / Linux
.\start_collector.ps1           # Windows PowerShell
```

启动后手机/电脑浏览器打开 <http://127.0.0.1:8790> 即可使用移动端题库界面（浏览提取记录、调用 AI 解答、配置模型）。真机访问用 `--host 0.0.0.0` 启动，手机连同一局域网访问电脑 IP。

配合 Chrome 插件使用：在插件侧边栏「题库采集」小节开启开关，之后在任意已授权的题目页面按 **Alt / ⌥ + Shift + E**，当前页全部题目即一键入库（工具栏图标闪 ✓/! 反馈结果）。快捷键走浏览器级命令，与系统冲突时可在 `chrome://extensions/shortcuts` 自行修改。每次提取保存为 `data/extractions/` 下的一个独立 JSON 文件，重复提取全部保留（附内容哈希）。

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
| `collector/server.py` | 题库采集服务（端口 8790，接收插件采集、服务移动端题库 UI）。 |
| `collector/service.py` | 提取记录存储（`data/extractions/` 每次提取一个 JSON）。 |
| `collector/solver.py` | 服务端 AI 解答（OpenAI 兼容接口，答案写回提取文件）。 |
| `collector/web/` | 移动端题库界面。 |
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
