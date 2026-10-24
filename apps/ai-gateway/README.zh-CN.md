# Open 3D AI 网关

[English](README.md)

可独立部署到 Cloudflare Workers 的可选原生 HTTP/SSE 中转应用。Modra 仍在浏览器内负责协议、历史、工具、审批和重试；网关只鉴权、限制目标并转发，不提供模型账号或 API 密钥。

## 部署网关

当 AI 服务商不支持浏览器跨域请求（CORS）时，Open 3D 提供轻量级网关，通过 Cloudflare Workers 转发请求。Cloudflare 提供的额度有限，当 Open 3D 官方网关不可用时，可以选择自部署方案。

### 1. 准备环境

Node.js >= 24.11、pnpm 和 Cloudflare 账号。

### 2. 克隆项目并安装依赖

```sh
git clone https://github.com/xiaohe0601/open-3d.git
cd open-3d
pnpm install
```

### 3. 部署网关

```sh
pnpm deploy:ai-gateway
```

选择 **Self-hosted（自部署）**，按终端提示完成配置。主要配置字段如下：

| 终端字段                                                | 如何填写                                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Deployment mode（部署模式）                             | 选择 **Self-hosted（自部署）**。                                                                    |
| Cloudflare account（Cloudflare 账号）                   | 有多个账号时，选择用于部署 Worker 的账号。                                                          |
| Worker name（Worker 名称）                              | 填写一个唯一的 Worker 名称。不要使用 `modra-ai-gateway`，该名称已被 Open 3D 官方部署占用。          |
| Allowed web origins（允许的网页来源）                   | 默认使用 `https://3d.xiaohe.ink`；如使用其他 Open 3D 部署地址，填写准确来源，不带路径和结尾的 `/`。 |
| Custom gateway hostname（自定义网关域名）               | 留空使用 Cloudflare 的 `workers.dev` 地址，或填写当前 Cloudflare 账号管理的域名。                   |
| Require a gateway access token?（是否启用网关访问令牌） | 公开部署建议选择 **Yes**。                                                                          |
| Access token（访问令牌）                                | 选择 **Generate securely（安全生成）**，或手动输入 32-256 个不含空格的字符。                        |
| Final confirmation（最终确认）                          | 检查配置摘要后输入 `yes` 开始部署。                                                                 |

部署完成后请保存终端输出的网关地址和令牌。若关闭令牌鉴权，网关将成为公开中转，Origin 不能代替鉴权。

### 4. 填写配置

打开 [Open 3D](https://3d.xiaohe.ink)，进入 **Modra → AI 服务设置**，连接方式选择 **自部署网关**，填写终端输出的网关地址和访问令牌（如已启用），并配置 AI 服务商的协议、API URL、模型和 API 密钥。

## 本地验证

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @open-3d/ai-gateway typecheck
WRANGLER_SEND_METRICS=false pnpm --filter @open-3d/ai-gateway dry-run
pnpm exec vp -C apps/ai-gateway test run
```

测试使用本地 workerd/Miniflare、模拟上游和假凭据，需要本地端口权限，不需要 Cloudflare 登录或模型账号。测试会先构建 Worker。Miniflare 与 Wrangler 版本一致；独立运行 workerd 避免 Cloudflare 测试池的 Vitest 4 要求与项目的 Vitest 5 冲突。

交互开发：将 `.dev.vars.example` 复制为被忽略的 `.dev.vars`，生成至少 32 字符、相互独立的随机部署令牌和身份签名密钥；配置准确的本地 Origin 后，显式启用中转，再运行 `pnpm --filter @open-3d/ai-gateway dev`。提交的默认配置关闭中转且允许列表为空，不可直接作为公开代理使用。不要提交真实凭据、`.dev.vars` 或 `.wrangler` 状态。

## 自部署网关协议

所有端点均检查准确的 Origin；这只是 CORS 防护，**不能代替鉴权**。预检无需令牌。响应均为 `Cache-Control: no-store`、`Vary: Origin`，不转发或返回 Cookie。

| 端点                   | 行为                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/capabilities` | 返回版本 1、协议列表、鉴权方式、启用状态和有效限制，不暴露上游配置或密钥。客户端必须在发送内容或凭据前检查兼容性。                               |
| `POST /v1/relay`       | 原生 JSON 请求字节和原生响应流。控制头为 `X-Open-3D-Protocol`、`X-Open-3D-Upstream`（完整上游 URL）、`X-Open-3D-Gateway-Token`（独立网关凭据）。 |
| `OPTIONS`              | 仅允许明确支持的端点、方法和请求头。                                                                                                             |

四种协议 ID：`openai-compatible`、`openai-responses`、`anthropic-messages`、`gemini`。鉴权方式为 `deployment-token`，或显式关闭令牌鉴权时的 `none`。服务商仍使用各自原生鉴权头；Gemini 密钥必须放在 `x-goog-api-key` 而不是 URL。网关凭据、Cookie、Origin、客户端身份头、SDK 遥测头及任意代理头均不发送到服务商。

网关错误只包含 `{error:{code:"gateway.<分类>"}}`；上游 401/429 等保留原状态和响应体，并标记 `X-Open-3D-Error: upstream`，不得把上游鉴权失败当成网关令牌错误。`Retry-After` 限制为 0–60 秒，网关自身不重试。流开始后发生错误只能中断流，不能改写已经发送的内容或撤回服务商操作。

## 重复部署与故障处理

最终确认前不会修改云资源。CLI 保留 DO 绑定/迁移、自动分配独立速率 namespace，将**非敏感配置**保存到被 Git 忽略的 `.wrangler/deploy/`。保留这些文件，以便重复部署时复用速率 namespace。重新执行会轮换身份签名密钥、上传选定的访问令牌，并短暂关闭中转；如生成或输入了不同的令牌，部署后需同步更新 Modra 中的令牌。CLI 不会打印身份签名密钥，也不会将访问令牌写入配置文件。

部署顺序为：关闭中转 → 上传 secrets → 启用中转 → 检查能力与 CORS。启用/健康检查失败会自动重新部署关闭配置；关闭也失败则明确提示立即人工处理。CLI 不自动删除云资源。

紧急关闭：将生成配置中的 `RELAY_ENABLED` 改为 `false`，执行：

```sh
pnpm --filter @open-3d/ai-gateway exec wrangler deploy --config .wrangler/deploy/YOUR-WORKER.json
```

回滚使用 `wrangler rollback --config .wrangler/deploy/YOUR-WORKER.json`，操作前检查目标版本，保留兼容的 secrets、绑定和 DO 迁移。删除浏览器令牌不等于服务端吊销。部署只由运营者主动执行，PR CI 不部署；公开启用前仍须核对负载、隐私设置和真实配额。

## 目标与资源限制

仅允许公共 HTTPS 主机、443 端口和四种原生操作路径。拒绝 IP、本地名称、URL 用户信息、路径穿越、模糊编码、额外/秘密查询参数和重定向。Gemini 仅允许准确的 `?alt=sse`。主机名文本校验不执行 DNS 解析，不能为任意恶意域名保证防 DNS 重绑定；运营者须审核上游基础设施、DNS 和跳转。无需配置服务商主机或基础路径白名单，支持兼容四种原生操作的自定义公共服务商。唯一可配置的允许列表为准确网页来源 `ALLOWED_ORIGINS`。自定义基础路径段仅支持字母、数字、下划线和短横线。

部署配置已开启客户端断连信号（`enable_request_signal`），分别管理上传空闲、响应开始、流式空闲和整体超时：

| 配置项                      | 默认值                      | 最大值     |
| --------------------------- | --------------------------- | ---------- |
| `MAX_REQUEST_BYTES`         | 48 MiB                      | 48 MiB     |
| `UPLOAD_IDLE_TIMEOUT_MS`    | 60 秒                       | 5 分钟     |
| `RESPONSE_START_TIMEOUT_MS` | 3 分钟                      | 10 分钟    |
| `IDLE_TIMEOUT_MS`           | 2 分钟                      | 5 分钟     |
| `TOTAL_TIMEOUT_MS`          | 10 分钟                     | 10 分钟    |
| `MAX_CONCURRENT`            | 每派生调用方 2 个           | 8 个       |
| `MAX_DEPLOYMENT_CONCURRENT` | 整个部署 32 个              | 128 个     |
| `MAX_DAILY_REQUESTS`        | 每 UTC 日 10,000 次准入转发 | 100,000 次 |

上传持续产生有效字节时，只刷新上传空闲计时。上传结束或上游提前返回响应头后，等待首个非空响应块；响应头本身不算模型输出，也不会延长等待时限。首块到达后，后续非空块刷新流式空闲计时；整体超时始终有效。慢速下行也可能触发流式空闲限制。取消会中止上游 fetch/读取，但不能保证服务商立刻停止推理或计费。

需要调整时，编辑生成的 `.wrangler/deploy/YOUR-WORKER.json`，再按[重复部署与故障处理](#重复部署与故障处理)中的命令重新部署。重新执行交互式 CLI 会恢复生成的默认值。旧配置未包含两个部署级限制时，继续使用调用方级准入；请**同时**添加两个部署级配置，或重新执行 CLI 升级。只配置一项或配置无效时拒绝转发。

提前检查声明长度，同时计数实际转发字节，不解析或重新编码大图片 JSON。五张 5 MiB 图片经 base64 编码约占 34 MiB，另需预留文字和工具开销；历史轮次中的图片也占用本次请求大小。分块请求超限前可能已部分到达上游，不能承诺原子拒绝或不产生费用。

边缘速率限制按 Cloudflare 地区近似执行，不是严格全局限制。`RelayAdmission` 使用持久化租约跨 Worker 实例协调。调用方 ID 通过可信平台客户端 IP、Origin 和日周期做 HMAC 派生，不使用服务商密钥、客户端自报身份或 grant ID。生产环境必须由 Cloudflare 入口覆盖 `CF-Connecting-IP`，不要公开接受伪造值的测试代理。共享 NAT/Origin 的用户共享调用方限制，换 IP 或跨日会获得新的调用方桶。

独立的部署级对象统一协调全站并发和 UTC 日计数，不会因用户更换 IP 或 Origin 而重置。每次通过准入的转发均计数，包括重试、标题生成、上下文压缩和随后失败的请求；完成或取消仅释放并发，不返还次数。额度耗尽返回 `gateway.quota`，Modra 不自动重试。相同命名空间下重启或重新部署不会清空计数；UTC 零点重置。更换 Worker 或命名空间会产生独立额度。

每次转发在请求上游前获取两级租约，完成、失败或取消时幂等释放；部署级拒绝时归还调用方租约。总时长加 30 秒宽限后，alarm 或下一次准入清理孤儿租约；UTC 日边界清理计数，但保留仍在运行的租约。缺少保护配置或协调失败时拒绝转发。持久化数据仅包含租约 ID、过期时间及汇总日期/次数，不包含 AI 内容或原始 IP。

这些是**转发次数和准入上限，不是费用或 Cloudflare 总请求数上限**。被拒绝的请求、预检、访问验证以及准入/存储/alarm 仍消耗平台资源。模型费用由用户的服务商账号承担，Worker/DO 费用由运营者承担；不能保证无限免费或防御全部分布式滥用。

## 隐私与运营

凭据、提示词、图片、工具结果和模型输出必然经过网关及平台的瞬时内存。应用默认不持久化、缓存、做内容分析或将这些载荷用于训练。代码不记录内容日志、不调用内容分析/Cache API，也不把生成任务放入后台继续。默认关闭 Wrangler observability；运营者仍须审核账号级日志/导出、tail、第三方异常抓取和 CDN 缓存，不要记录 Request/Response 对象。

DO 租约和日计数是必要的、会持久化且会过期的**安全元数据**，与 AI 内容分开说明。Cloudflare/服务商仍按各自政策处理基础设施元数据；不能承诺基础设施层面零留存。自部署用户必须自行确认运营者、配置、日志、DNS、允许列表和数据安全。中转不绕过服务商政策或模型权限。

公开启用网关前，用真实大小的五图请求验证 CPU/内存、增量流、准入/释放延迟、请求/存储/alarm 消耗及异常回收。开启部署级保护后，正常每流两次 DO acquire 和两次 release，孤儿回收会增加 alarm/存储操作。核对**实际账号当时**的 Worker、DO SQLite 读写/存储配额与[价格](https://developers.cloudflare.com/durable-objects/platform/pricing/)，并阅读[近似速率语义](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。免费套餐不代表无限或永久免费，超额可能被拒绝或产生费用。本地测试不代表完成生产账号配额审核，也不会部署服务。

### 不采集内容的监控

使用 Cloudflare 内置的 Worker 和 Durable Object 汇总指标查看请求量、错误、CPU、时长及存储操作。检查账号支持的配额/账单通知，为持续错误和接近配额设置告警。无需接入分析 SDK、记录内容、添加诊断接口或携带密钥的探测。保持 Workers Logs、tail 抓取及请求/响应体导出关闭，除非经过独立审核。CLI 不配置账号级告警。

### 上线验收清单

本地测试不能验证真实 Cloudflare 网络、服务商权限或区域可用性。发布前，请使用可撤销、低额度的服务商凭据，从实际允许的网站测试：

1. 四种协议分别发送短消息，确认增量输出、建模工具调用与批准、后续会话正常，再验证标题生成和上下文压缩。
2. 在限速网络上传五张有代表性的图片，确认持续上传不被响应开始时限打断；再验证真正停止上传、模型长时间无输出时的超时行为。
3. 分别在等待响应头和流式输出时停止请求，并关闭浏览器连接，确认随后能正常请求。服务商是否停止推理或计费必须单独核对，不能仅凭界面判断。
4. 在测试部署降低并发/每日限制，使用不同客户端网络，确认超限请求不会到达上游，完成后并发恢复，重新部署保留计数，UTC 零点恢复额度。完成后恢复正式配置。
5. 确认未允许的来源/预检被拒绝，且在内容日志保持关闭时仍能查看平台汇总指标。CLI 的能力检查不能代替这些验收。