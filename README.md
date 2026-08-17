# CyberWikiBench 使用手册

CyberWikiBench 是一套本地网络安全知识题的**采集、解答与评测**工具，由三部分组成，可单独使用：

| 组件 | 说明 | 默认地址 |
| --- | --- | --- |
| **Chrome 插件** | 页面题目提取、浮窗解题/填入、一键采集入库 | — |
| **题库采集服务** | 接收插件采集，移动端题库浏览/检索/AI 解答 | `http://127.0.0.1:8790` |
| **Benchmark 评测服务** | 从规范题库抽题、图形化作答、自动评分 | `http://127.0.0.1:8765` |

全部服务为 Python 标准库实现（无需安装任何第三方包）；插件为原生 MV3，无构建步骤。

---

## 1. Chrome 插件

### 1.1 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录。
3. 之后每次修改插件代码，回到此页点扩展卡片上的刷新 ↻ 重载，并**关闭后重新打开侧边栏**（重载后旧侧边栏会白屏，属正常现象）。

### 1.2 配置模型（选项页）

入口：`chrome://extensions` → CyberWikiBench → 「扩展程序选项」，或侧边栏「管理模型」。

以 DeepSeek 为例：

| 字段 | 填写 |
| --- | --- |
| 接口协议 | OpenAI-compatible Chat Completions |
| 完整 Endpoint | `https://api.deepseek.com/v1`（Base 地址即可，自动补全调用与模型列表路径） |
| 模型列表地址 | 留空（自动推导，失败时自动回退 `/v1/models`、`/models`） |
| API Key | 你的 `sk-` 开头密钥 |

操作顺序：填协议/地址/Key → 点「刷新模型列表」→ 从列表选模型（如 `deepseek-chat`）→ 「保存配置」→ 「测试连接」显示绿色即成功。

- 想走 Anthropic 协议：Endpoint 填 `https://api.deepseek.com/anthropic/v1/messages`，模型列表地址填 `https://api.deepseek.com/v1/models`。
- 多个模型可保存多份配置，设一个默认模型；复核/备用模型在侧边栏「路由设置」里选择。
- API Key 只保存在浏览器本地 `chrome.storage.local`，不会出现在导出设置里。

### 1.3 授权网站

插件只能读取你授权过的网站：

- **选项页 → 站点授权**：输入网址（如 `https://ks.wjx.com`）点「添加授权」，列表中可随时移除。
- 内置 `127.0.0.1` / `localhost` 无需授权。
- 未经授权的页面上，浮窗与快捷键均不生效。

### 1.4 浮窗解题

侧边栏 → 答题设置 → 「低干扰浮窗」→ 开启并点「在当前页面显示或更新」。授权页面右下角出现小白点：

- **点白点**：展开面板；再点头部可收起。**按住拖动**可移动位置。
- 面板操作：题号下拉切换 → 「提取」识别当前页题目 → 「解答」调用模型 → 「填入」把答案写回页面（**不会自动提交**）。
- **低调模式**：浮窗平时以极低透明度（1%–30% 可调）隐藏，鼠标靠近或按 `Alt / ⌥ + Shift + X` 唤醒；展开即固定显示，收起即回到低调态。
- 「内容区点击穿透」开启后浮窗不挡页面点击（仅顶部可操作）。
- 关闭按钮 × 只隐藏**当前标签页**的浮窗，去侧边栏重新应用即可恢复。

### 1.5 一键采集入库

前提：题库采集服务已启动（见第 2 节）。

1. 侧边栏 → 答题设置 → 「题库采集」→ 开启开关。
2. 启用多用户鉴权时，填写服务端分配的 **User ID** 和 **Key**。
3. 点「测试采集服务连接」——显示 `连接成功 · 用户 xxx` 即凭据有效。
4. 点底部「**保存答题设置**」。
5. 在任意已授权的题目页面按 **`Alt / ⌥ + Shift + C`**：当前页全部题目一键发往题库。工具栏图标反馈：绿色 `✓` 上报成功；黄色 `?` 页面没有识别到题目；红色 `!` 网络/服务/权限错误。

快捷键是浏览器级命令，与系统冲突时去 `chrome://extensions/shortcuts` 自行修改。

---

## 2. 题库采集服务

### 2.1 启动

```bash
./start_collector.sh            # macOS / Linux
.\start_collector.ps1           # Windows PowerShell
python -m collector.server --host 127.0.0.1 --port 8790   # 直接启动
```

手机访问：`./start_collector.sh --host 0.0.0.0`，手机连同一局域网访问电脑 IP 的 8790 端口。

### 2.2 移动端题库 UI

浏览器打开 `http://127.0.0.1:8790`，三个视图（底部 tab 切换）：

- **题库**：提取记录卡片流（时间/来源/题数/已解数），顶部搜索框按**题干、选项、答案**关键词检索，结果点击直达对应题目并高亮定位。
- **详情**：逐题显示题干与选项，「AI 解答」单题作答，「全部解答」批量作答未解题；答案、置信度、模型、耗时写回文件持久保存。
- **设置**：配置服务端 AI 模型（OpenAI 兼容 Base 地址 + API Key + 模型 ID，如 `https://api.deepseek.com/v1` + `deepseek-chat`），「测试连接」验证；Key 只存本机 `data/collector_config.json`，已保存后留空表示不修改。

### 2.3 多用户鉴权（可选）

创建 `data/collector_auth.json` 即启用，**保存后立即生效，无需重启**：

```json
{ "users": { "gyy": "key-gyy-xxxx", "lhr": "key-lhr-yyyy" } }
```

- 采集内容按用户分目录：`data/extractions/<userId>/`，互相隔离。
- 所有 API 与网页均需凭据：网页首屏出现登录页；插件侧边栏填同样的 User ID/Key。
- User ID 限 1–32 位字母/数字/下划线/连字符。
- 删除该文件（或 users 留空）即回到无凭据的开放模式（共享 `default` 空间）。

### 2.4 数据格式

- 每次提取 = `data/extractions/<userId>/<UTC时间戳>-<内容哈希>.json` 一个独立文件，含来源 URL/标题/提取时间与全部题目。
- 重复提取全部保留（内容哈希相同也各存一份），便于事后去重。
- AI 解答结果直接写回该文件对应题目的 `answer`/`confidence`/`model` 等字段。

完整 HTTP 契约（含鉴权头、检索、解答端点）见 [docs/API.md](docs/API.md)。

---

## 3. Benchmark 评测

### 3.1 启动

```bash
./start_benchmark.sh            # macOS / Linux
.\start_benchmark.ps1           # Windows PowerShell
```

打开 <http://127.0.0.1:8765>。默认只监听本机；运行数据在 `data/benchmark_runs.sqlite3`。

### 3.2 图形化评测

- 选择单选题/判断题/混合题型，设置数量、来源与可复现随机种子。
- 自动记录作答进度与耗时；提交后自动评分（准确率、P95 延迟、逐题结果）。
- 生成持久化的测试集 ID 与评分结果 ID，便于多模型对比。

### 3.3 CLI 模型评测

支持任何 OpenAI 兼容接口，API Key 从环境变量读取：

```powershell
$env:LLM_API_KEY = "your-key"
python scripts/run_model_benchmark.py `
  --benchmark-url http://127.0.0.1:8765 `
  --model-url https://your-provider.example/v1/chat/completions `
  --model your-model-name `
  --count 50 --types single_choice,true_false `
  --parallel 4 --seed 20260810 `
  --report runs/your-model-50.json
```

### 3.4 HTTP API 最短流程

1. `POST /api/v1/test-sets` 创建不含答案的测试集。
2. 将返回的 `questions` 交给模型或插件作答。
3. `POST /api/v1/submissions` 提交答案并获得自动评分。

完整字段与示例见 [docs/API.md](docs/API.md)。

---

## 4. 常见问题

| 现象 | 原因与解决 |
| --- | --- |
| 重载扩展后侧边栏白屏 | 重载会销毁旧面板。关闭侧边栏再点扩展图标重新打开即可。 |
| 快捷键采集报 401 | ①扩展重载后才会发送鉴权头；②侧边栏未填 User ID/Key 或未点「保存答题设置」；③Key 与 `data/collector_auth.json` 不一致（以文件当前内容为准）。 |
| 快捷键与系统冲突 | 到 `chrome://extensions/shortcuts` 改键。 |
| 模型列表能刷新但测试连接失败 | Endpoint 填了 Base 地址（如 `/v1` 结尾）即可自动补全为 `/chat/completions`；确认扩展已重载新代码。 |
| 某网站提取不到题目 | 需先在选项页「站点授权」；仍不行时把该题 HTML 片段反馈开发。常见框架（问卷星、Element Plus 考试页等）已适配。 |
| 浮窗按钮点不了 | 展开态即固定可点；若开了「内容区点击穿透」，仅顶部可操作，关闭该开关即可。 |
| 悬浮框按钮一直转圈（等待光标） | 后台请求未返回导致的旧卡死问题已通过客户端超时修复：等待「请求超时或连接中断」提示后即可重新操作；极少数情况刷新页面立即恢复。 |
| 手机打不开 8790 | 用 `--host 0.0.0.0` 启动，手机与电脑同一局域网，访问电脑 IP。 |

---

## 5. 主要文件

| 路径 | 用途 |
| --- | --- |
| `extension/` | Chrome 插件（MV3：service worker、content scripts、侧边栏、选项页）。 |
| `collector/server.py` | 题库采集服务（HTTP + 移动端 UI 托管）。 |
| `collector/service.py` | 提取记录存储与检索。 |
| `collector/auth.py` | 多用户鉴权（`data/collector_auth.json`）。 |
| `collector/solver.py` | 服务端 AI 解答（OpenAI 兼容，答案写回文件）。 |
| `collector/web/` | 移动端题库界面。 |
| `benchmark/server.py` | Benchmark HTTP 与静态页面服务。 |
| `benchmark/service.py` | 抽题、持久化与自动评分核心。 |
| `web/` | 图形化评测页面。 |
| `scripts/run_model_benchmark.py` | 大模型 CLI 自动评测器。 |
| `scripts/parse_question_bank.py` | 原始题库解析与 JSONL 校验。 |
| `data/questions.jsonl` | 规范题库源数据。 |
| `docs/API.md` | 全部 HTTP API 契约（含采集服务与插件接入）。 |
| `docs/Chrome插件开发.md` | 插件加载、模型协议、RAG 接口与 Benchmark 使用说明。 |
| `docs/题库数据标准.md` | 新增题目的标准格式。 |

本地运行数据均被 git 忽略：`data/extractions/`、`data/collector_config.json`（含模型 Key）、`data/collector_auth.json`（含用户 Key）、`data/benchmark_runs.sqlite3`。

## 6. 测试

```bash
python -m unittest discover -s tests -v      # 服务端（benchmark + collector）
node --test extension/tests/*.test.mjs       # 插件纯逻辑模块
```

## 7. 安全说明

当前定位是本机/可信局域网工具：服务默认只监听 `127.0.0.1`，模型与用户密钥仅存本机且接口返回掩码。正式跨设备部署前应增加固定 Token、来源白名单与 TLS，避免将服务绑定 `0.0.0.0` 暴露到不可信网络。
