# TabDo-plugins

TabDo 的独立插件市场，由 DwenChen 维护。应用读取 main/index.json；插件来源、发布包和更新由本仓库管理。

## 开发与收录

规范以 [TabDo 插件开发规范](https://github.com/DwenChen/TabDo/blob/main/docs/plugin-development.md) 为准，副本见 docs/plugin-development.md。原项目的保活和跟随启动流程已被 session-v1 替代，旧插件需适配并验证后再收录。

1. 在 plugins/<稳定名称>/ 中提交完整源码、plugin.json、本地图标、README 和许可。
2. plugin.json 声明 lifecycle: session-v1；参照 hello-tabdo 的资源登记与有限任务。
3. 为 index.json 增加平台、版本、来源与 HTTPS 下载地址，附资源释放及私有数据保留证据。
4. 运行 npm ci、npm run check、npm run build，通过 PR 审查后发布新的市场 tag。

CI 校验目录与索引一致性并构建 Brotli ASAR 格式的 ZPX，只有 v* tag 才发布包。不会构建未知仓库代码或同步旧市场目录。首次收录的“会话示例”用于开发演示。

讨论使用 Issues，提交使用 Pull Requests。无需原市场账号、服务器或用户保活设置。TabDo 应用：[DwenChen/TabDo](https://github.com/DwenChen/TabDo)。

感谢 [ZToolsCenter/ZTools-plugins](https://github.com/ZToolsCenter/ZTools-plugins) 的插件目录与独立市场管理思路，以及原插件开发项目。此仓库为独立实现，不表示原市场插件已通过新协议适配。
