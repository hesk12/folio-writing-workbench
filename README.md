# Folio · 文书工作台

Folio 是一个本地运行的中文写作工具，适合迭代研究生申请的 Statement of Purpose 和 Personal Statement。左侧写正文，右侧选中一段加批注，让 AI 根据同一版草稿给出反馈。你可以逐条查看建议，编辑后再采纳。

## 快速开始

安装 Node.js 24.5 或更新版本，下载或克隆本仓库，在仓库目录运行：

~~~sh
npm start
~~~

打开 <http://127.0.0.1:43827>。Windows 用户也可以双击 **打开文书工作台.cmd**。基础写作功能无需安装 npm 依赖或配置模型账号。

## 如何使用

1. 点击项目选择器旁的加号，为学校或项目新建 SOP 或 PS。
2. 在「项目资料」中记录题目、研究经历和学校的 AI 使用要求，按实际要求选择协作范围。新项目默认暂停 AI。
3. 在「文稿」中写作；选中正文或模型回复的一段即可引用和批注。普通编辑会自动保存为 Markdown。
4. 在「模型设置」中配置协作者。Claude 和 Gemini 使用你自己的 OpenRouter API 密钥，GPT 使用本机已通过 ChatGPT 账号登录的 Codex CLI。请按账号可用情况选择模型，也可以填写自定义型号。
5. 发送问题后可查看本轮文稿快照、查阅过的资料和修改建议。Claude 与 Gemini 的双评会分别发起模型请求。

## 数据和联网

默认目录为用户主目录下的 `.folio/data`。每份文稿保存在独立的项目目录中，讨论、设置与共享资料也保存在本机。通过 `FOLIO_DATA` 可指定其他目录，例如 Obsidian 库中的专用文件夹。备份时请一并备份该目录中的隐藏文件。

服务仅监听本机回环地址。发送 AI 请求时，文稿、问题、项目上下文以及查阅的资料会传给所选服务。共享资料库对本机各项目可用，模型可按需查阅。启用联网搜索时可使用服务商搜索。GPT 的本地记忆选项允许读取 Codex 记忆与数据目录内的项目偏好。OpenRouter 请求按账号计费；GPT 路径使用 Codex 账号额度。

Windows 使用当前用户的 DPAPI 加密保存界面输入的 OpenRouter 密钥；其他平台仅在当前服务进程中保留。也可在启动前设置 `OPENROUTER_API_KEY`。请勿将密钥或个人资料提交到仓库。

## 可选配置

- `FOLIO_PORT` 设置服务端口，默认 43827。自定义端口请使用 `npm start` 并打开终端显示的地址。
- 导入 Markdown 和 TXT 使用内置读取器。DOCX 导入需要 Python 3，文字版 PDF 另需在同一 Python 环境安装 `pypdf`。可将 `FOLIO_PYTHON` 指向虚拟环境中的 Python 可执行文件。
- GPT 评阅需要可用的 Codex CLI，在终端完成 `codex login` 后使用。
- 运行 `npm test` 检查本地工作流。测试使用模拟模型回复。

## License

Folio is released under the [MIT License](LICENSE). The bundled Markdown renderer, Marked, retains its [upstream license notices](public/marked.LICENSE.md).
