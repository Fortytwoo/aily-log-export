# Aily Runtime Log Exporter

飞书 Aily 运行日志 ZIP 导出 Chrome 插件。

## 功能

- 在 `*.feishu.cn` 的 Aily 运行日志列表页注入页面内导出工具栏。
- 在运行日志表格行旁添加多选框，支持批量选择多个 `trace ID`。
- 批量打开所选 `trace ID` 对应详情页，采集运行日志后导出为一个 ZIP 文件。
- 详情页支持当前 trace ZIP 导出、深度 ZIP 导出，以及 span 多选 ZIP 导出。
- 深度导出会优先通过 `trace_tree` 主动补齐所有 span 详情，接口补齐失败时再回退到页面点击采集。
- 优先缓存页面运行时的同源日志接口响应，接口不可用时导出当前页面可见详情。

## 使用

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，选择本仓库目录。
4. 打开飞书 Aily 运行日志列表页，选择需要导出的 `trace ID`。
5. 点击右下角“导”按钮展开面板，再点击“导出选中 ZIP”。

导出面板默认收起，展开后可拖动标题栏移动位置，避免遮挡飞书原有筛选和表格操作。

导出的 ZIP 可能包含业务日志、模型输入输出、工具调用结果等敏感信息，请按内部数据权限管理。

## 本地校验

```powershell
.\scripts\generate-icons.ps1
node .\scripts\validate-extension.mjs
```

## Chrome Web Store 构建

Chrome Web Store 上传使用 ZIP 包：

```powershell
.\scripts\build-webstore.ps1
```

输出文件位于 `dist/aily-runtime-log-exporter-v<version>-webstore.zip`，可直接在 Chrome Web Store Developer Dashboard 中上传。

如需本地 CRX 测试包，可运行：

```powershell
.\scripts\build-crx.ps1
```

CRX 和 PEM 私钥会生成在 `dist/`，这些文件已被 `.gitignore` 排除。不要提交 PEM 私钥。

发布页文案、权限说明、审核说明和隐私政策草稿见：

- `docs/chrome-web-store-submission.md`
- `docs/privacy-policy.md`

GitHub Pages 隐私权政策页面：

- https://fortytwoo.github.io/aily-log-export/privacy-policy.html
