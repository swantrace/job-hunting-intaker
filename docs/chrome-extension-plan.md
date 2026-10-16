# Chrome Extension：Tab Group 职位采集与批量分析计划

日期：2026-10-16。状态：设计与实施计划；扩展在独立 repository 实现。

配套后端计划：[job-intake-api-plan.md](job-intake-api-plan.md)。API v1 字段、限额、
身份规范和响应以该文档为共同契约；启动扩展仓库时复制两个文件并保留版本。
后端实现将交付 OpenAPI 和 JSON fixtures；扩展消费固定版本，不猜测后端 DB 结构。

## 1. 范围和用户流程

目标：用户已打开 LinkedIn、Indeed 等多个职位页面，放入一个 Chrome Tab Group；
扩展采集选定 group，将正文/元数据提交到 Job Tracker，后台追踪到 Candidate
Analysis 结束，显示一次系统通知。用户在 app 只需处理未知证据的 Include/Skip。

1. Options 配置 Job Tracker 地址、导入 token，点击 Test connection。
2. 用户选择一个当前窗口 Tab Group，看见其可采集标签页列表/失败原因。
3. 按已匹配的网站规则采集，预览条数、标题、公司、URL 和正文完整性。
4. 用户明确点击 Import N jobs；超过后端单批上限按序分批，显示提交进度。
5. 可以关闭 popup；后台继续上传/恢复重试/查询，不依赖 popup 常驻。
6. 全部子批次达到终态时汇总通知，点击打开 app 的批次/本次导入结果。
7. 未获通知权限时仍有 badge、popup 状态和 View results 链接。

不执行 OpenAI 请求，不保存 OpenAI key，不自动生成 Documents、不自动投简历。
不自行维护候选人职业事实，不把页面采集值标记为用户已确认。
不自动访问 group 外标签页，不在页面运行任意用户脚本。

## 2. 建议技术结构（独立仓库）

Manifest V3 + TypeScript，复用 Bun 开发工具；原生 HTML/CSS 和浏览器 APIs 即可，
无需为了 popup 引入 React、服务器或大框架。项目自选轻量构建工具并产出可加载
的 dist extension；安装流程和权限有清晰 README。

```text
src/
  background.ts          # 事件监听、持久化任务协调、alarm、消息认证
  contracts/             # 固定 API v1 类型/验证与测试 fixtures
  extraction/            # 按规则读取 DOM/JobPosting JSON-LD，无凭证
  rules/                 # 规则 schema、匹配、URL identity 计算、预置模板
  api/                   # service worker fetch、认证、限额/重试
  storage/               # rules/settings/短期待提交项/已通知状态
  popup/                 # group 选择、预览、提交与进度
  options/               # 服务器/凭证、网站规则、测试提取
tests/
  fixtures/              # 合成页面/载荷，不提交真实个人页面
```

一职责一模块，按需要拆分；不为每个 DOM 字段创建类或通用爬虫框架。
不接入当前 app 工作区代码，也不复制后端事实/评分逻辑。

## 3. 权限与信任边界

- 按需使用 tabGroups、tabs、scripting、storage、alarms 和 notifications。
  逐个验证实际需要，不用 <all_urls> 作为默认授权。
- activeTab 只能提供有限的当前 tab 访问，不能用它假定整个 group 都可注入。
  网站采集和 Job Tracker API 各有对应 host permissions；添加网站时申请对应
  optional host 权限。若声明覆盖多站点的 optional pattern，也只请求用户添加的域。
- 扩展 popup/options/service worker 属于可信上下文；content extraction 仅返回数据。
  token 仅由 service worker 使用；chrome.storage.local 设置 accessLevel 为
  TRUSTED_CONTEXTS（按目标 Chrome 版本确认支持），不写 sync、不写日志/导出。
- URL、正文、DOM 和 JSON-LD 视为不可信；不接受页面指定的 API 地址或请求 headers。
  检查消息 sender/frame/tab，提取脚本不能借消息接口请求任意带 token 的 URL。
- API 生产 HTTPS，本地 HTTP 仅 localhost/127.0.0.1；错误证书不提供绕过选项。
- 收集的是用户已打开并能读取的内容；不绕登录/CAPTCHA/反爬、不后台爬整站。

## 4. 可管理的网站规则

规则存 chrome.storage.local，可导入/导出 JSON。仅规则可导出；不包含 token、
采集正文、浏览历史。预置 LinkedIn/Indeed 模板与用户自定义规则可分开管理，
升级不覆盖用户改动；生产 selector 必须在实际支持布局上验证，不能猜测有效。

一个网站可有多套页面规则，例如职位详情页和搜索页侧栏；唯一优先级匹配，
冲突显示 Ambiguous rule 让用户选择，不随机使用最后一个。

规则字段：

| 配置 | 含义 |
| --- | --- |
| id / version / label / enabled | 稳定规则身份，编辑增加版本 |
| hostnames / pathname pattern / optional route match | 适用范围，不匹配任意页面 |
| rootSelectors | 当前职位的根节点，避免推荐职位串入 |
| field selectors | rawText、jobTitle、companyName、location、postedDate、salary |
| read mode | text、innerText 或指定 attribute，按字段白名单 |
| fallback selectors | 顺序尝试，首个有效结果；不能拼接重复职位 |
| field source priority | JSON-LD 与 CSS 的明确优先级，可按字段设定 |
| applicationSource | LinkedIn/Indeed 等自由文本名称 |
| providerJobId extractor | query 参数、path 段或明确 DOM attribute |
| identity policy | queryMode/queryParams/dropQueryParams/fragmentMode，与 API 一致 |

只支持有界的声明式转换：trim、空白/换行整理、明确日期格式解析。
不允许 eval、任意 JavaScript、远程脚本、无限 regex、任意自动点击序列。
DOM selector 可抛错，捕获为字段级规则错误。属性名/URL/数据大小均校验。
如果第一版不支持任意日期文本解析，传 null 并保留 datePosted 原文来源即可。

Options 提供规则 Add/Edit/Save/Cancel、选择当前 tab、Test extraction，显示：
命中布局/root、每个字段的采用值和来源、fallback 使用情况、缺失项和正文预览。
缺标题/公司允许后端占位/补充；缺 rawText 或 sourceUrl 不可提交。

### JSON-LD 和复杂页面处理

- JobPosting 类型结构化数据是一个来源，不盲目信任第一个 application/ld+json。
  支持 @graph/数组，多个 JobPosting 需和当前 URL/ID/root 关联；不能明确选中就报错。
- JSON-LD description 的 HTML 在隔离解析中转纯文本，保留段落/列表，不注入页面。
- 正文保留结构，排除脚本、导航、推荐职位、个人账户/招聘站私信等无关区域。
- 页面尚未加载可在用户明确采集期间有界等待目标节点（例如上限 10 秒），
  失败提示展开/加载后重试，不固定 sleep 多分钟。
- 初版要求用户手动展开完整 JD；不配置任意自动点击。可识别截断提示并标记警告。
- 无法采集时允许用户在扩展预览中粘贴该页面正文；URL 仍取当前页面，绝不省略。
- 每次采集记录 tab URL/页面职位 ID；读取前后 SPA 路由/当前职位改变则丢弃结果并
  提示重新采集，避免 A 的 URL 配上 B 的正文。不要只依赖 tabs.url 识别侧栏职位。
- iframe/shadow DOM 第一版只支持明确可访问布局；不声称通用 selector 可以穿透它们。

## 5. URL 身份规则与后端协作

sourceUrl 原样保留。identity providerJobId 可从页面读出，必须与当前具体职位关联，
不能用列表页/container ID。网站 namespace 由后端根据 host 验证，不由插件随意指定。

identity.policy 的 API v1 字段：

```json
{
  "version": 1,
  "queryMode": "keep-listed",
  "queryParams": ["jobId"],
  "dropQueryParams": ["utm_source"],
  "fragmentMode": "drop"
}
```

- queryMode: keep-all（默认）或 keep-listed；param 名称大小写精确保留。
- keep-listed 仅在规则作者知道职位身份参数时使用；保留/删除列表不能重叠。
- fragmentMode: keep（默认）或 drop；hash route 网站需要 keep。
- 不默认删除全部 query，不默认丢 fragment，不盲目改 path 大小写或合并主机。
- 可在 Test extraction 显示“用于去重的 URL/ID”，不替换用户打开的原始 URL。
- 服务端独立重算并约束 identity；不要只发送不可验证的客户端 hash。
- ruleVersion 用于溯源；不能把版本加入职位 identity，让升级规则后所有职位变新。
- 同站同 ID/规范 URL 重复直接忽略，不因正文改变重分析；结果链接原 application。
- 不跨 LinkedIn/Indeed/公司官网根据标题公司合并。无 URL 输入不属于本扩展入口。
- group 内可先提示明显重复，但保留来源，后端唯一约束才是最终裁决。

## 6. 请求契约与可靠提交

向已配置 app 的 `POST /api/v1/job-intake/batches` 发送 JSON，并带专用 Bearer token
和 Idempotency-Key。字段详见后端计划；不要发送 priority/status/个人 skill 或模型 key。
required: schemaVersion=1、clientBatchId、items[*].clientItemId/sourceUrl/rawText。
optional: applicationSource、suggestedMetadata、capture、identity。

限额基线：单批 20，body 4 MiB；rawText 60,000 字符且 UTF-8 128 KiB；URL 2048；
title/company/location 200；salary/source 150。优先读取 capabilities 的服务端限制。
字段合法时空值用 null/省略，不用字符串 "null"；postedDate 必须是真实日期。

- 提交前生成且持久化 operation ID、每个子 batch 的 clientBatchId/idempotency key、
  item ID 和规范化载荷。worker/popup 重启不能为相同重试重新生成 key。
- 同样 key 的重试必须同样 payload；修改预览属于新提交操作，使用新 key。
- 超过上限分批，控制上传并发（起点 1–2），不是对每个 tab 发一个 OpenAI 请求。
- 202/200：保存 batchId/status URL/review URL，处理 per-item accepted/duplicate/rejected。
  422 既可能 envelope 无效，也可能全 items rejected 且有 batchId，按 JSON 字段区分。
  409 内容冲突不可无限重试，提示明确重新提交。
- 网络断开/5xx/可重试 429：有界退避、遵从 Retry-After，复用幂等 key；401/403 停止
  重试并显示 Reconnect。请求超时不等于服务器没接收，应按原 key 查询/重放。
- 一个 tab 的提取失败不影响其它有效项。预览保留逐项失败和可重试原因。
- API 返回的链接必须解析到配置 app 的同一 origin 和允许路径，防开放跳转。
- 正文只短期保留用于未确认提交/重试；服务器确认接收后删除本地正文，仅保留
  批次 ID、item 映射和状态。待发送项提供清理按钮，禁止 token 混入诊断导出。

## 7. 后台追踪和一次性通知

使用 chrome.alarms + storage.local，不使用 popup/setInterval 作为后台调度依据。
MV3 worker 可随时停止，所有必要状态持久化，监听器在模块顶层注册。

- API 返回 isTerminal/revision/terminalRevision，不自行用 intake ready 推断完成。
- completed item 仅指 Candidate Analysis 完成；有待 Include/Skip 仍算自动流程结束。
- duplicate/rejected/failed 为本次终态；不要追踪已有申请后续历史状态到无限期。
- 根据 Chrome 支持的 alarm 周期和 API polling hint 轮询（后台约 30–60 秒起步），
  不承诺精确秒级通知；失败退避，不为完成批次继续轮询。
- 一个用户提交 operation 如拆成多个 API batch，默认全部终态后发一次汇总；
  popup 随时可看已完成子批次，某个最终失败不阻止汇总结束。
- 通知展示 completed/duplicate/failed/rejected 数量及待决定数，不泄漏 JD 正文。
  示例：“10 个职位处理结束：6 个已分析、2 个重复、2 个失败；5 项待决定。”
- 通知点击打开批次结果；多 batch 时打开 app import 列表并突出本 operation 的批次，
  或扩展结果页列出各批次，不能随便只链接最后一个。
- 用 operation ID + 所有 batch terminalRevision 生成稳定 notification ID，持久化
  delivered 状态；通知创建与写本地状态间崩溃时，使用相同 ID 更新现有通知，
  避免重复堆叠。不承诺跨崩溃绝对 exactly-once 声音。
- 在 startup/onInstalled/popup 打开时检查并补建所需 alarms；不要假定 alarm 永不丢。
- 用户明确开启通知时请求 permission；拒绝不阻塞导入，仍显示 badge/结果。
- 浏览器关闭或操作系统禁用通知时无即时保证；重新打开后恢复未完成追踪。
- 网站/扩展均不需要本轮实现 Web Push/FCM 或新通知服务器。不要为持续轮询新增长连接。

## 8. 服务器配置和 UX

Options 可切换本地/生产 target，各自保存 token、host permission 和连接状态。
排队任务绑定提交时的服务器 origin，不因切换环境被误发到另一个 app。
切换 host/credential 清晰提示对已有待提交项的影响，查询旧 batch 不能使用新主机。

popup：Group selector -> tabs/采集结果 -> Import -> progress/result。支持键盘和明确
label/focus/loading/error，不用颜色单独表达状态。公司/地点未知不强制补齐才能导入。
既有 app Review 中的数据编辑不在扩展重复实现，直接打开对应申请。

## 9. 实施阶段与验收

| 阶段 | 交付 | 验收 | 建议 commit |
| --- | --- | --- | --- |
| 1 | MV3 skeleton、TS/build/tests、固定 API fixtures | 可加载 unpacked，popup/options/worker 正常 | chore: initialize job capture extension |
| 2 | settings/token/host permissions/Test connection | 本地/生产隔离、401 可理解、token 不暴露页面 | feat: connect extension to job intake API |
| 3 | 网站规则管理、JSON 导入导出、Test extraction | 多布局/备用 selector、参数规则、无脚本执行 | feat: configure website extraction and URL identity rules |
| 4 | Tab Group 选择、正文/JSON-LD 提取、预览 | 多 tab 权限、SPA 对应、段落、逐项失败隔离 | feat: capture grouped job posts with source metadata |
| 5 | 批量提交、切批、持久化幂等重试 | 断网后恢复、不重复申请、schema/limit 一致 | feat: submit resumable job intake batches |
| 6 | alarms 状态追踪、badge、通知/点击 | popup 关闭/worker 重启仍跟踪、终态准确、去重 | feat: notify when candidate analysis batches finish |
| 7 | 规则/权限/隐私 README、联调验收 | 真实授权页面手动验证预置规则，API mock E2E | docs: document extension setup and capture workflow |

## 10. 必要测试和边界

- 合成 DOM：JSON-LD @graph、多个 JobPosting、description HTML、无 root、selector 错误、
  两种布局、截断正文、推荐职位污染、SPA 在读取时改变、iframe 不支持时正确报错。
- identity：ID query/path/attribute；必要 query 不丢，fragment route 保留，规则升级
  不改变已有明确 ID；不把 tab group/list 页当唯一职位 URL。
- 后端共享 fixtures：可选 null、bad URL/date、item 限额、Unicode 字节限额、401/409/
  422/429/5xx、mixed duplicate/rejected/completed、Candidate 未完成不通知。
- chrome API mocks：group 外 tab 不访问、permission 拒绝、worker 重启、alarm 重建、
  同一 notification ID、防 content-script 越权消息和 credential 泄漏。
- operation 多子批、部分最终失败、切换服务器、popup 重开、网络 response 丢失后
  幂等重放、同批 later manual rerun 不重复完成通知。
- 真实 Chrome 手动 smoke test 权限/通知/系统行为；DOM fixtures 不能证明实际网站
  selectors 永久有效。禁止将登录 HTML、个人 JD/凭证提交到 Git。

最终联调：选组 -> 提取 -> 提交 -> 后端 pending skills 自动解析 -> Candidate 完成
-> 一次通知 -> Review 默认只看待决定项 -> Include/Skip -> 手动生成 Documents。

## 11. 官方资料

计划阶段通过 Context7 核对；实现时按最低支持 Chrome 版本确认 API 能力：

- [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Tab groups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
- [Storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
