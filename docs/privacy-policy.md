# Privacy Policy

Effective date: 2026-06-09

## Overview

Aily Runtime Log Exporter is a Chrome extension for exporting selected Feishu Aily runtime logs from `*.feishu.cn` pages into local JSON files.

## Data Processed

The extension may process the following data when the user opens a matching Feishu Aily runtime-log page:

- Runtime log table rows, including trace IDs, environment, user, start time, channel, conversation ID, duration, and version.
- Runtime detail page content, including visible input, output, span summaries, and same-origin runtime-log responses.
- Temporary export queue state stored locally while selected trace IDs are processed.

## Data Storage and Retention

All processing happens locally in the user’s browser. Temporary export state is stored with Chrome local storage only while a batch export is running and is removed after completion. Exported JSON files are downloaded to the user’s device and are controlled by the user.

## Data Sharing

The extension does not send runtime log data, trace IDs, exported JSON, cookies, tokens, or browsing activity to any external server. The extension does not sell or share user data and does not use data for advertising, profiling, or analytics.

## Permissions

The extension requests access only for `https://*.feishu.cn/*` so it can add export controls to Feishu Aily runtime-log pages across Feishu subdomains. The `storage` permissions are used for local temporary export state.

## Security

Users should treat exported JSON files as sensitive because runtime logs may contain business data, model input/output, tool results, or other internal information.

## Contact

For issues or privacy questions, use the GitHub repository: https://github.com/Fortytwoo/aily-log-export
