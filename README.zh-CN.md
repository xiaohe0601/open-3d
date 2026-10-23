# Open 3D

**AI 原生的浏览器端建模工具，支持专业操作和自然语言建模**

> [!IMPORTANT]
> 项目正在积极开发，各项功能与工作流将陆续支持

[English](README.md) | 简体中文 | [在线体验](https://3d.xiaohe.ink)

Open 3D 将专业 3D 建模工作流与自然语言交互深度融合于一体化的浏览器工作区，实现更流畅、连贯且高效的创作体验。

## 特性

- **专业工作流：** 生产级三维内容创作，涵盖几何建模、数字雕刻、材质与着色、动画及渲染等。
- **AI 原生支持：** 自然语言驱动建模，场景上下文理解、工具调用与操作提案预览。
- **自选 AI 服务：** 支持自定义 API 端点、模型标识与访问密钥，接入兼容的模型推理服务。
- **浏览器端运行：** 提供浏览器端交互式三维视口与 GPU 加速实时渲染，无需安装桌面客户端。
- **灵活项目管理：** IndexedDB 本地持久化、原生项目序列化与 GLB/glTF 场景互操作，衔接资产交换流程。
- **自适应工作区：** 响应式面板布局、主题与国际化支持，适配不同视口尺寸和操作偏好。

## 文档

- [建模工作流](docs/guides/first-modeling-workflows.md)
- [项目文件格式与交换限制](docs/guides/project-file-formats.md)
- [AI 隐私与故障排查](docs/guides/ai-privacy-and-troubleshooting.md)
- [工作区偏好](docs/guides/workspace-preferences.md)
- [包边界](docs/architecture/package-boundaries.md)
- [建模核心 API](docs/architecture/modeling-core-api.md)
- [测试策略](docs/validation/testing-strategy.md)

## 许可证

项目原创代码采用 [MIT License](LICENSE)，第三方代码、图标、样式和字体保留各自许可证，不会因本项目采用 MIT 而被重新授权。