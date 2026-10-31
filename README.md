# keats-courseware-scraper

**KEATS课件爬取** —— DeepSeek Harness 插件。把一套 KEATS 抓取脚本（Cookie 提取 → 课程发现 → 文件枚举 → 下载 → SharePoint 链接）重写为纯 Node 引擎并封装成插件。安装后即可用固定指令全自动执行，文件每次都会保存到一个**新的文件夹**。

## 安装

在 DeepSeek Harness 的插件管理器（Plugin Manager）中安装本包：

```
keats-courseware-scraper
```

或从本地目录/ tarball 安装。安装后无需重启即可使用。

## 固定指令（两种触发方式）

1. **斜杠命令（确定性触发，推荐）**：在输入框输入
   ```
   /keats
   ```
   即可全自动执行整条流水线；也可带课程关键词过滤，例如 `/keats Machine Learning`。

2. **自然语言（由模型自动调用工具）**：直接说
   ```
   爬取KEATS课件
   ```
   模型会立即调用 `keats_scrape` 工具自动执行（默认抓取全部已选课程、不追问）。

## 执行内容（全自动）

1. 从本机 Chrome 远程调试端口（默认 9222）读取 KEATS 登录 Cookie（**只驻留内存，不落盘**）；
2. 用 Moodle AJAX 接口列出全部已选课程（含过往/未来/隐藏）；
3. 逐课程枚举 section → 下载所有 File 资源、Folder 内容（同时保留 folder 原始 ZIP 结构）、收集 SharePoint/OneDrive 等外部链接；
4. 检测到微软 Cookie 时尝试走 OAuth form_post 流程下载 SharePoint 文件；
5. 文件存入新文件夹 `<输出目录>/keats-downloads/<时间戳>/<课程名>/`，并生成 `manifest.json`、`courses.json`、`progress.log`。

## 使用前提

- 本机 Chrome 需以远程调试模式启动并登录 KEATS：
  ```
  chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\keats-chrome https://keats.kcl.ac.uk/
  ```
  登录完成（微软 SSO + MFA）后保持该 Chrome 运行，再执行指令。
- 未检测到 KEATS 登录态时，指令会返回清晰的启动指引，按指引操作后重试即可。

## 插件配置（可选，`cordis.patch.yml` 中该插件行的 config）

| 键 | 默认值 | 说明 |
|---|---|---|
| `chromeDebugPort` | `9222` | Chrome 远程调试端口 |
| `outputDir` | `''` | 下载根目录；留空 = 当前会话目录 |
| `courses` | `[]` | 固定要抓的课程 ID 列表；空 = 全部已选课程 |
| `downloadSharePoint` | `true` | 是否尝试下载 SharePoint/OneDrive 链接 |
| `concurrency` | `4` | 文件下载并发数 |

## 安全

- Cookie 只在内存中使用，绝不写入磁盘。
- 视频（kalvidres / Lecture Capture）默认不下载。

## License

MIT
