# Tampermonkey Scripts

这个仓库收录可通过 Tampermonkey 运行的浏览器用户脚本。

## 脚本

- [notion-to-markdown-tool.js](./notion-to-markdown-tool.js) 将当前 Notion 页面的正文导出为 Markdown，方便交给无法访问 Notion 的工具或智能体。
- 在 Notion 页面右下角点击「下载 Markdown」。脚本会自动滚动收集正文，完成后恢复原来的阅读位置。
- 导出保留标题、嵌套列表、表格和行内代码。支持识别的附件以 `[文件名]` 表示。
- Markdown 在浏览器本地生成和下载，页面正文不会发送给外部服务。
