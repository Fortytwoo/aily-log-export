# Aily Runtime Log Exporter

飞书 Aily 运行日志 JSON 导出 Chrome 插件。

## 功能

- 在 `feishu.cn` 的 Aily 运行日志页注入页面内导出工具栏。
- 在 trace 节点旁添加多选框，支持批量选择。
- 将选中的 trace/span 导出为 JSON 文件。
- 优先缓存页面运行时的同源日志接口响应，接口不可用时导出当前页面可见详情。

## 使用

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，选择本仓库目录。
4. 打开飞书 Aily 运行日志页，选择需要导出的 trace。
5. 点击页面内“Aily 日志导出”面板中的“导出选中 JSON”。

导出的 JSON 可能包含业务日志、模型输入输出、工具调用结果等敏感信息，请按内部数据权限管理。

## 本地校验

```powershell
.\scripts\generate-icons.ps1
node .\scripts\validate-extension.mjs
```

