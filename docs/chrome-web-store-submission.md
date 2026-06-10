# Chrome Web Store Submission Content

Use `dist/aily-runtime-log-exporter-v<version>-webstore.zip` from `.\scripts\build-webstore.ps1` as the upload package.

## Store Listing

**Extension name:** Aily Runtime Log Exporter

**Short description (zh-CN):** 批量导出飞书 Aily 运行日志 trace ID 详情为本地 ZIP 文件。

**Short description (en):** Export selected Feishu Aily runtime trace IDs and logs as local ZIP files.

**Detailed description (zh-CN):**

Aily Runtime Log Exporter 用于在飞书 Aily 智能体运行日志页面批量备份和检查运行日志。

主要功能：

- 在飞书 Aily 运行日志列表中添加轻量多选框。
- 支持从列表页一次选择多个 trace ID。
- 自动依次打开所选 trace 详情页，并导出为一个 ZIP 文件。
- 支持在单个运行详情页导出当前 trace、深度采集 ZIP，或按 span 选择导出 ZIP。
- 导出流程只在浏览器本地执行，不使用外部服务器。

适用对象：飞书 Aily 智能体管理员、构建者、运维支持和内部排障人员。适用于需要备份近 30 天运行日志、复盘问题、留存调试证据的场景。

**Detailed description (en):**

Aily Runtime Log Exporter helps Feishu Aily builders back up and inspect runtime logs from the runtime-log page.

Key features:

- Adds non-intrusive checkboxes to the Feishu Aily runtime log table.
- Supports selecting multiple trace IDs from the list page.
- Opens selected trace details in sequence and exports the collected runtime logs as one ZIP file.
- Supports current-trace ZIP export, manual deep ZIP export, and span-level ZIP export on a runtime detail page.
- Keeps the export workflow local in the browser; no external server is used.

This extension is intended for Feishu Aily administrators, builders, and internal support teams that need repeatable runtime log backup for debugging and audit workflows.

**Category:** Developer Tools / Productivity

**Primary language:** Chinese (Simplified)

**Additional language:** English

**Official website / support URL:** https://github.com/Fortytwoo/aily-log-export

**Privacy policy URL:** https://fortytwoo.github.io/aily-log-export/privacy-policy.html

## Privacy Tab

**Single purpose:**

Export selected Feishu Aily runtime log records from `*.feishu.cn` pages into user-downloaded ZIP files for debugging and backup.

**User data handling summary:**

The extension reads runtime log table rows and runtime detail content only on matching Feishu Aily runtime-log pages. Selected trace IDs, temporary export progress, captured same-origin runtime responses, and generated ZIP files stay local in the user’s browser/device. The extension does not send data to any external server and does not sell, share, or use data for advertising.

**Data disclosure suggestion:**

- Website content: used locally to read visible runtime log rows, trace IDs, detail text, and same-origin runtime responses.
- User activity: not collected for analytics or tracking.
- Authentication information: not collected. The extension does not read cookies or passwords.

## Permission Justifications

**`activeTab`:** Allows the extension popup to communicate with the currently active Feishu Aily runtime-log tab when the user opens the popup or triggers export actions.

**`storage`:** Stores temporary batch export state while the extension navigates through selected trace detail pages. Data is local and removed after export completion.

**`unlimitedStorage`:** Avoids interruption when selected runtime logs are large. Storage is only used locally for temporary export queue/state.

**`downloads`:** Lets the extension open the exported ZIP location after a user-triggered export. It is not used to read or upload downloaded files.

**Host permission `https://*.feishu.cn/*`:** Allows the extension to work across Feishu subdomains where Aily runtime-log pages may be hosted, while the content script still activates only on `/ai/.../builder/runtime-log` pages.

**Web-accessible resource `src/page-hook.js`:** Injects a small page-context hook to capture same-origin runtime-log responses for more complete ZIP export. It does not communicate with external servers.

## Test Instructions for Review

1. Load or install the extension.
2. Open a Feishu Aily runtime log list page under `https://<tenant-or-app>.feishu.cn/ai/.../builder/runtime-log`.
3. Confirm a small “导” floating button appears at the lower-right corner.
4. Select one or more runtime log table rows by checkbox.
5. Open the floating panel and click “导出选中 ZIP”.
6. Confirm a ZIP file is downloaded after the selected trace detail pages are processed.

Reviewer credentials may be required because Feishu Aily runtime-log pages are authenticated internal pages.

## Required Store Assets Checklist

- 128x128 extension icon: `icons/icon128.png`
- At least one screenshot showing runtime-log row selection and the collapsed “导” button.
- Optional screenshot showing the expanded export panel.
- ZIP package from `.\scripts\build-webstore.ps1`
- Privacy policy URL
