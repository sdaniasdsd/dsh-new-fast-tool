# DSH Task Runtime

**模型选择已安装插件 → 独立 DSH 子进程挂载 → 前端就绪 → 原始任务交接 → 正式对话。**

入口只运行模型/config/credential 基础服务和调度插件，界面是轻量任务页。模型选择能力后才启动任务子进程；后续对话使用子进程中的官方 DSH Web 界面。无需手动逐个勾选插件。

## 使用

需要 Node 24+、已经安装的 `@deepseek-ai/dsh`、配置好模型的 Web profile。本版实际检查使用 DSH `0.2.1-rc.3`。

```powershell
cd E:\project\_investigate_ai_learning_assistant_launcher\plugins\dsh-task-runtime
npm ci
node src/cli.mjs prepare --cwd E:\project\my-project
node src/cli.mjs check
node src/cli.mjs start
```

`start` 自动打开本机任务入口，默认端口 3186。输入任务，模型自动选择插件，子进程就绪后显示正式会话。返回入口可查看/停止任务。每个入口默认最多同时运行两个任务；Ctrl+C 结束入口及其子进程。

也可安装分发包：`npm install ./dsh-task-runtime-0.1.0.tgz`，然后运行 `npx dsh-task-runtime prepare ...` / `npx dsh-task-runtime start`。这是一个 DSH bundle，但需要配套生成的精简 profile；把 bundle 直接添加到原来的全量 profile 不会减少原有启动开销。

```powershell
node src/cli.mjs prepare `
  --source-home C:\Users\AA\.dsh --profile web `
  --state E:\dsh-task-runtime-state `
  --dsh-root C:\Users\AA\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh `
  --provider deepseek-official --model deepseek-flash `
  --cwd E:\project\my-project --max-runtimes 2

node src/cli.mjs start --state E:\dsh-task-runtime-state
```

默认读取原 profile 的模型选择。可用 `--provider` / `--model` 覆盖，目标模型需已配置好。环境变量密钥需要从启动命令继承。源模型设置/凭据复制到隔离目录；模型不可用时，规划阶段会显示错误，不会降级成全量加载。

`--no-open` 禁止自动打开浏览器。访问令牌保存在私有状态目录的 `router-access.json`；手动访问 `http://127.0.0.1:3186/#token=<token>`。令牌不写入诊断日志。

## 选择与依赖

内置十个能力组：文件、文档预览、终端、联网、skills、子智能体、定时任务、规划、工作流、开发工具。根据源 profile 实际存在的插件行建立目录；模型只返回目录 ID，宿主校验并补齐明确声明的依赖。源配置的非 DSH 模块（包括本地路径）也作为可选能力。

共享基础服务及未分组第一方插件保留为 core。v0.1 提供受控能力分组，不承诺所有 DSH 内部服务都能分别开关。过滤覆盖 Host 和各 agent preset，防止未选工具从 preset 重新出现。子进程基于 Standard 生成唯一的 `task-runtime` preset，交接时显式指定它，避免源默认 Minimal 等配置导致选中工具未挂载。基础层原本禁用、由 preset 接管的工具行保留作用域规则。`composition-report.json` 列出子进程实际保留的配置行；配置行数不是实际运行实例数，也不是性能测量结果。

复杂第三方插件可用 `prepare --catalog capabilities.json` 增补准确描述和依赖：

```json
[
  {
    "id": "my-diagram",
    "title": "流程图绘制",
    "description": "创建和编辑流程图",
    "rows": ["diagram-host", "diagram-client"],
    "requires": ["files"]
  }
]
```

`rows` 是源配置中的插件 ID。重复分组、未知插件、未知依赖和循环依赖会被拒绝。模型不能生成模块路径、命令或 YAML。官方包优先从当前安装解析，避免源 profile 的旧依赖或源码链接混入基础服务。

## 生命周期与数据

- 正常 DSH_HOME 作为只读输入。每个任务都有独立 home、profile、会话和存储；复用已安装代码，不为每次任务重新安装插件。
- 源凭据复制到私有状态目录，移除浏览器会话签名后重新生成。显式 credentials/session/storage/attachment 路径被重定向到子进程目录。无法安全改写的源 home 表达式会报错。
- 状态目录包含密钥、任务原文和会话数据。默认 `.runtime/` 已排除 Git/npm 包。POSIX 文件请求 0600、目录 0700；Windows 使用所在目录的账户 ACL。不要分享整个状态目录。
- 前端桥接等待浏览器插件树稳定，并审计所选 Host/Client 条目和任务 preset 的实际挂载树是否激活；失败时原任务不提交。成功后创建/打开会话，再使用固定 requestId 提交原文。刷新不会重复提交。
- 并发任务有上限，启动/挂载有超时，停止只处理本入口拥有的进程树。
- 任务范围启动时确定。后续任务需要新能力时创建新任务；本版不迁移 live Session，不在 turn 中重启基础服务。
- Node 子进程隔离后台运行时。入口以 iframe 显示会话，并不保证浏览器分配独立渲染进程；单个插件的 DOM/CSS 或事件循环缺陷仍需单独修复。

更新 DSH、安装/更新插件或改变源 profile 后，先停止入口和任务，再重新 `prepare`。`check` 验证安装版本和生成配置；它不调用模型。

## 验证

```powershell
npm test
npm run test:installed
node test/installed-smoke.mjs documents
```

单元检查覆盖嵌套插件过滤、依赖、无效选择、隔离路径、进程取消/上限/超时、HTTP 授权和原消息门控。实际安装检查启动真实 router/worker，并用 headless Chrome 验证浏览器挂载；`checkOnly` 不创建正式会话、不向模型发送任务。可用 `DSH_TEST_BROWSER` 指定 Chrome/Edge 可执行文件。

真实模型规划、助手回答、各业务插件的功能没有在此检查中测试。无密钥验证结果和界面截图保存在私有状态目录。
