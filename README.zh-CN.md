# Open 3D

**AI 原生的浏览器端建模工具，支持专业操作和自然语言建模**

> [!IMPORTANT]
> 项目正在积极开发，各项功能与工作流将陆续支持

[English](README.md) | 简体中文 | [在线体验](https://3d.xiaohe.ink)

Open 3D 将专业 3D 建模工作流与自然语言交互深度融合于一体化的浏览器工作区，实现更流畅、连贯且高效的创作体验。

![](./docs/assets/demo.png)

## 特性

- **专业工作流：** 生产级三维内容创作，涵盖几何建模、数字雕刻、材质与着色、动画及渲染等。
- **AI 原生支持：** 自然语言驱动建模，场景上下文理解、工具调用与操作提案预览。
- **自选 AI 服务：** 支持自定义 API 端点、模型标识与访问密钥，接入兼容的模型推理服务。
- **浏览器端运行：** 提供浏览器端交互式三维视口与 GPU 加速实时渲染，无需安装桌面客户端。
- **灵活项目管理：** IndexedDB 本地持久化、原生项目序列化与 GLB/glTF 场景互操作，衔接资产交换流程。
- **自适应工作区：** 响应式面板布局、主题与国际化支持，适配不同视口尺寸和操作偏好。

## 文档

- [Modra 建模任务工作区](docs/guides/modra.zh-CN.md)
- [AI 连接方式与可选网关](docs/guides/modra-connection-routes.zh-CN.md)
- [建模工作流](docs/guides/first-modeling-workflows.md)
- [项目文件格式与交换限制](docs/guides/project-file-formats.md)
- [AI 隐私与故障排查](docs/guides/ai-privacy-and-troubleshooting.md)
- [工作区偏好](docs/guides/workspace-preferences.md)
- [包边界](docs/architecture/package-boundaries.md)
- [建模核心 API](docs/architecture/modeling-core-api.md)
- [测试策略](docs/validation/testing-strategy.md)

## 部署 AI 网关

当 AI 服务提供商不支持浏览器跨域请求（CORS）时，Open 3D 提供轻量级网关，通过 Cloudflare Workers 转发请求。Cloudflare 提供的额度有限，当 Open 3D 官方网关不可用时，可以选择自部署方案。

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

运维与安全说明见[网关指南](apps/ai-gateway/README.zh-CN.md)。

## 许可证

项目原创代码采用 [MIT License](LICENSE)，第三方代码、图标、样式和字体保留各自许可证，不会因本项目采用 MIT 而被重新授权。