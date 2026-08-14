# CyberWikiBench Chrome 插件（MVP）

插件目录为 `extension/`，采用 Chrome Manifest V3、原生 JavaScript 和 Side Panel；不需要 Node.js、打包器或服务器端代理。

它有两条独立能力：

- 在普通网页中提取当前网络安全题目，调用所选模型给出答案，并在用户确认后填入页面；插件不会自动提交试卷。
- 调用本仓库的 Benchmark API 创建固定测试集、逐题调用模型并提交答案，得到可复现的自动评分结果。

## 加载与启动

1. 在项目根目录启动本地 Benchmark 服务：

   ```powershell
   .\start_benchmark.ps1
   ```

   Linux / macOS 请运行：

   ```bash
   ./start_benchmark.sh
   ```

2. 在 Chrome 打开 `chrome://extensions`，开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择项目中的 `extension` 文件夹。
4. 点击工具栏中的 CyberWikiBench 图标打开侧边栏；从侧边栏的“模型设置”进入配置页。

开发时修改源文件后，在 `chrome://extensions` 点击该扩展的刷新按钮，再刷新目标网页。

## 模型配置

每个模型配置（Profile）都是独立的，可在设置页保存多个并选择默认项。密钥只保存在当前浏览器的 `chrome.storage.local`，不会同步到 Chrome 账号；不要把包含密钥的浏览器配置或截图发给他人。

| 协议 | Endpoint 示例 | 鉴权方式 | 适用范围 |
| --- | --- | --- | --- |
| OpenAI-compatible Chat Completions | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer <key>` | OpenAI、兼容网关、vLLM、Ollama/LM Studio 的兼容接口等 |
| Anthropic Messages | `https://api.anthropic.com/v1/messages` | `x-api-key: <key>`，并带 `anthropic-version` | Anthropic Messages API |
| 本地 OpenAI-compatible | `http://127.0.0.1:8000/v1/chat/completions` | 选择“无需鉴权” | 本机小模型、局域网推理服务 |

Endpoint 必须填完整的请求地址，而不是只有域名。首次调用新域名时，Chrome 会弹出该域名的访问授权；这是可选站点权限，用于避免扩展默认拥有所有网站的网络访问能力。

插件调用 OpenAI-compatible 接口时使用 Chat Completions 请求体；调用 Anthropic 时使用 Messages 请求体。因此同一个模型网关只要兼容其中一种协议即可接入。

### 模型目录与实时配置更新

在模型设置页中，填写 Endpoint 和 API Key 后可点击“刷新模型列表”。对于 OpenAI、Anthropic 和实现了兼容接口的服务，插件会在后台请求与该 Endpoint 同源的 `GET /v1/models`，并使用各协议对应的认证头，将当前密钥可见的模型 ID 放入可搜索的选择器中；选择后仍可手动填写自定义模型 ID，以兼容未实现模型目录接口的本地服务或网关。

模型目录请求只在扩展的 Service Worker 中执行，API Key 不会返回到网页 Content Script 或写入日志。目录中会默认优先展示适合文本对话的候选模型；如果需要，也可以切换为查看服务端返回的全部模型。模型目录接口仅提供基础模型元数据，选择后建议仍使用“测试连接”确认该模型可用于所选 Chat Completions Endpoint。

保存、设为默认、启用、禁用或删除模型配置后，已打开的 Side Panel 会自动同步下拉列表，后续请求立即采用最新配置，不需要重新打开 Side Panel。已经开始的单次求解或 Benchmark 会继续使用启动时解析出的配置，以避免运行中途切换模型影响结果；修改扩展源代码本身仍需要在 Chrome 扩展管理页重新加载扩展。

## 侧边栏工作流

1. 打开含题目的正常网页，点击“提取当前题目”。首次访问一个网站时，Chrome 会弹出该网站的读取授权；允许后插件会识别页面中的全部可见题目，并显示题目选择器。同一域名后续不需要重复授权。
2. 在选择器中切换到目标题目，检查题干与选项后点击“求解”。
3. 核对模型答案后，点击“填入答案”。填入操作不会触发网页的提交按钮。

答题模式可按目标切换：

- “极速”优先选择已配置的快速模型，适合本地小模型低延迟作答。
- “均衡”在首答没有可解析答案或置信度低于阈值时才调用复核模型。
- “严谨”对每题调用复核模型；答案不一致时选择置信度更高的有效答案。

备用模型只会在主模型请求失败时启用。填入前插件会确认当前仍是提取题目的同一标签页。

### 低干扰浮窗

Side Panel 的“设置”页可启用低干扰浮窗。启用时需要由用户授权当前普通网页；之后插件会在已经授权的网站中挂载一个使用 Shadow DOM 隔离样式的紧凑浮窗。折叠态显示为 AssistiveTouch 风格的小白点，点击整个白点即可展开，按住拖动可调整位置；展开后点击明确的“收起”按钮即可恢复小白点。浮窗支持固定透明度、内容区点击穿透，以及提取、解答和安全填入操作，鼠标悬停不会改变透明度。关闭按钮只隐藏当前标签页，可刷新页面或从 Side Panel 重新显示，填入答案仍不会触发表单提交。

浮窗只接收脱敏后的题目、模型结果与显示设置，API Key 和完整模型配置始终留在扩展后台。该模式的目的只是减少页面遮挡，不提供也不承诺规避录屏、监考系统或网站监管。

提取器采用通用语义启发式：同时发现原生 radio/checkbox、ARIA radio/checkbox、自定义选项节点以及连续的 `A/B/C/D` 或数字选项；再结合题干、最小公共容器、选项顺序和控件类型计算识别置信度。radio 推断为单选，checkbox 推断为多选，明确的“正确/错误、是/否、√/×”选项推断为判断题；没有可靠控件或文字提示时保留为“类型待确认”的选择题。已覆盖开放 Shadow DOM 和问卷星常见结构，但浏览器内置页、Chrome Web Store 及没有额外权限的跨域 iframe 仍无法读取。

题目边界和选项容器分别推断，避免选项列表较深时丢失外层题干。题干依次来自有语义的标题节点、选项容器之前的近邻结构、以及“题目容器减去选项”后的剩余文本；返回数据的 `recognition.stemSource` 会标记实际来源。若候选题干只是选项文本或题号，整道候选会被拒绝，而不是把不完整题目交给模型。

纯文本 ABCD 题目可以提取和调用模型，但如果页面没有原生 input，插件不会模拟不明按钮点击；只有能够绑定到原生 radio/checkbox 的题目才允许安全填入。所有填入操作只触发 input/change 事件，不会自动提交表单。

## 本地 RAG / Embedding 接口

MVP 支持将本地检索服务作为可选加速/核实层。插件不绑定某一种向量数据库或 embedding 模型：你可以用 FAISS、Chroma、Qdrant、Milvus、SQLite-vec，或本地 embedding 模型，在本机实现一个很小的 HTTP 适配器。

在模型设置中开启 RAG 后，插件会向配置的检索 Endpoint 发出：

```json
{
  "query": "题干和选项文本",
  "top_k": 3,
  "collection": "可选知识库名称"
}
```

检索端点应返回以下任一形式（`chunks`、`results` 或 `documents` 均可）：

```json
{
  "chunks": [
    {
      "text": "与题目有关的可信知识片段",
      "source": "RFC / 教材 / 内部知识库来源",
      "score": 0.92
    }
  ]
}
```

插件最多取 10 个片段，并默认把拼接后的上下文限制为 6000 字符。检索失败或超时会降级为直接模型作答，而不会中断做题；检索到的文本会被明确标记为“参考资料”，其中的指令不会被当作模型指令执行。

推荐的本地链路如下：

```text
Chrome 插件
  ├─ OpenAI-compatible 本地小模型（低延迟初答）
  ├─ 本地 RAG 适配器 → embedding 模型 → 向量库（知识核实）
  └─ 可选云端 OpenAI / Anthropic（高难题或复核）
```

当前仓库提供的是插件到 RAG 服务的协议和调用层，不附带向量库、embedding 模型或知识库索引构建器。这样可避免把具体模型、显存需求和企业资料绑定到浏览器扩展中。

## Benchmark 模式

在侧边栏中选择题型、题量和随机种子后，点击“运行 Benchmark”。插件执行以下过程：

1. `POST /api/v1/test-sets` 创建不含标准答案的测试集。
2. 以所选 Profile 逐题调用模型（并发数最多为 4）。
3. `POST /api/v1/submissions` 提交模型答案和延迟。
4. 显示准确率、正确数、时延及逐题评分。

固定题库版本、`types`、`sources`、`domains` 与 `seed`，可让不同模型得到相同题目和顺序。Benchmark 默认地址是 `http://127.0.0.1:8765/api/v1`，可在设置中改为其他可信服务地址。完整 HTTP 契约见 [API.md](API.md)。

Benchmark 中的 RAG 是可单独开关的。评测“纯模型能力”时关闭它；评测“完整做题助手能力”时开启它，并在结果的 client 元数据中记录 `rag_enabled`。

## 扩展内部消息契约

所有内部消息使用 `{ type, payload }`，响应统一为 `{ ok: true, data }` 或 `{ ok: false, error }`。主要消息如下：

| 消息 | 发起者 | 用途 |
| --- | --- | --- |
| `EXTRACT_CURRENT_QUESTION` | Side Panel → Service Worker → Content Script | 提取当前标签页题目 |
| `SOLVE_CURRENT_QUESTION` | Side Panel → Service Worker | 调用选中的模型并可选使用 RAG |
| `FILL_ANSWER` | Side Panel → Service Worker → Content Script | 仅填入答案，不提交 |
| `TEST_MODEL_CONNECTION` | 设置页 → Service Worker | 测试当前 Profile |
| `RUN_BENCHMARK` | Side Panel → Service Worker | 创建测试集、调用模型、提交评分 |
| `GET_BENCHMARK_STATUS` | Side Panel → Service Worker | 查询运行进度 |

Content Script 不具备调用模型、读取 Profile 或读取 API Key 的权限；Service Worker 会拒绝网页脚本发起的敏感消息。

## 验证清单

```powershell
# 验证项目 Benchmark 后端
python -m unittest discover -s tests -v

# 验证扩展的 JavaScript 语法（系统安装 Node.js 后）
Get-ChildItem -Recurse extension -Filter *.js | ForEach-Object { node --check $_.FullName }
```

手工验证时，先用一个本地无鉴权 OpenAI-compatible 端点测试，再测试一个云端 Profile。确认 Benchmark 服务健康检查可通过后，用 2～5 道固定种子的题目做一次冒烟评测。
