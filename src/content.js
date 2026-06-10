(function () {
  "use strict";

  const APP_ID = "aily-runtime-log-exporter";
  const HOOK_SOURCE = "aily-runtime-log-exporter-hook";
  const CHECKBOX_CLASS = "aily-log-export-checkbox";
  const ROW_MARK_CLASS = "aily-log-export-row-mark";
  const RUN_ATTR = "data-aily-log-export-run-id";
  const SPAN_ATTR = "data-aily-log-export-span-key";
  const JOB_KEY = "ailyRuntimeLogExportJobV2";
  const MAX_RAW_EVENTS = 240;
  const MAX_DOM_SNAPSHOTS = 80;
  const SPAN_DETAIL_PREFETCH_CONCURRENCY = 5;
  const DETAIL_WAIT_MS = 1400;
  const RUN_DETAIL_TIMEOUT_MS = 30000;

  const state = {
    selectedRunIds: new Set(),
    selectedSpanKeys: new Set(),
    runRows: new Map(),
    spanNodes: new Map(),
    rawEvents: [],
    runtimeRequestHeaders: {},
    domSnapshots: [],
    domSnapshotKeys: new Set(),
    lastCaptureAt: 0,
    lastExportZipFileName: "",
    observer: null,
    toolbarHost: null,
    toolbar: null,
    scanTimer: null,
    mode: "unknown",
    exporting: false,
    resumingJob: false,
    booted: false
  };

  const spanLabelPattern =
    /^(运行总览|意图识别|主\s*Agent\s*循环|LLM\s*思考|工具调用|逻辑结束|get_skills|bash|tool|技能|deepseek[-_\w]*|.+Agent.*)$/i;
  const spanTextPattern =
    /(运行总览|意图识别|主\s*Agent\s*循环|LLM\s*思考|工具调用|逻辑结束|get_skills|bash|deepseek|工具调用|\btool\b)/i;
  const durationPattern = /(\d+(?:\.\d+)?\s*(?:ms|s|min|秒|分钟))/i;

  function isRuntimeLogPage() {
    return isFeishuHost(location.hostname) && /\/builder\/runtime-log\/?$/.test(location.pathname);
  }

  function isFeishuHost(hostname) {
    return hostname === "feishu.cn" || hostname.endsWith(".feishu.cn");
  }

  function getRuntimeParams() {
    const params = new URLSearchParams(location.search);
    const segments = location.pathname.split("/").filter(Boolean);
    const builderIndex = segments.indexOf("builder");
    return {
      agentId: builderIndex > 0 ? segments[builderIndex - 1] : "",
      runId: params.get("run_id") || "",
      spanId: params.get("span_id") || ""
    };
  }

  function isRuntimeLogListPage() {
    return isRuntimeLogPage() && !getRuntimeParams().runId;
  }

  function isRuntimeLogDetailPage() {
    return isRuntimeLogPage() && Boolean(getRuntimeParams().runId);
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\u200b/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return undefined;
    }
  }

  function textHash(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${hash >>> 0}`;
  }

  function getVisibleRuntimeText() {
    return cleanText((document.body && document.body.innerText) || "");
  }

  function captureDomSnapshot(label) {
    const text = getVisibleRuntimeText();
    if (!text) {
      return false;
    }
    const key = textHash(text);
    if (state.domSnapshotKeys.has(key)) {
      return false;
    }
    state.domSnapshotKeys.add(key);
    state.domSnapshots.push({
      capturedAt: new Date().toISOString(),
      label,
      textLength: text.length,
      text
    });
    if (state.domSnapshots.length > MAX_DOM_SNAPSHOTS) {
      state.domSnapshots.splice(0, state.domSnapshots.length - MAX_DOM_SNAPSHOTS);
    }
    return true;
  }

  function isElementVisible(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function getElementLabel(element) {
    const label =
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.textContent ||
      "";
    return cleanText(label).split("\n")[0].slice(0, 80);
  }

  function getRowText(row) {
    return cleanText((row && row.innerText) || (row && row.textContent) || "");
  }

  function getRuntimeBaseUrl() {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    return url;
  }

  function buildRunDetailUrl(runId) {
    const url = getRuntimeBaseUrl();
    url.searchParams.set("run_id", runId);
    return url.href;
  }

  function getCellTexts(row) {
    return Array.from(row.children || []).map((cell) => cleanText(cell.innerText || cell.textContent || ""));
  }

  function parseRunRow(row) {
    if (!row || row.tagName !== "TR" || !isElementVisible(row)) {
      return null;
    }

    const rowText = getRowText(row);
    if (!rowText || /trace ID\s+会话 ID|状态\s+环境\s+用户/.test(rowText)) {
      return null;
    }

    const traceMatch = rowText.match(/\b\d{16,}\b/);
    if (!traceMatch) {
      return null;
    }

    const cells = getCellTexts(row);
    const traceId = cells.find((cell) => /^\d{16,}$/.test(cell)) || traceMatch[0];
    const conversationId =
      cells.find((cell) => /^conversation_/.test(cell)) ||
      (rowText.match(/\bconversation_[\w-]+\b/) || [""])[0];
    const startTime =
      cells.find((cell) => /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(cell)) || "";
    const offset = /^(线上|开发|测试|灰度|预发)$/.test(cells[0] || "") ? 0 : 1;

    return {
      key: traceId,
      runId: traceId,
      traceId,
      detailUrl: buildRunDetailUrl(traceId),
      row,
      rowText,
      cells,
      statusText: offset === 0 ? "" : cells[0] || "",
      environment: cells[offset] || "",
      user: cells[offset + 1] || "",
      startTime,
      channel: cells[offset + 3] || "",
      conversationId,
      quota: cells[offset + 6] || "",
      durationText: cells[offset + 7] || "",
      version: cells[offset + 8] || ""
    };
  }

  function collectRunRows() {
    const rows = Array.from(document.querySelectorAll("tr"));
    const result = [];
    const seen = new Set();

    for (const row of rows) {
      const parsed = parseRunRow(row);
      if (!parsed || seen.has(parsed.runId)) {
        continue;
      }
      seen.add(parsed.runId);
      row.setAttribute(RUN_ATTR, parsed.runId);
      result.push(parsed);
    }

    return result;
  }

  function createRunCheckbox(item) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = CHECKBOX_CLASS;
    checkbox.title = "选择此 trace ID 用于 JSON 导出";
    checkbox.setAttribute("aria-label", `选择 trace ID ${item.traceId}`);
    checkbox.dataset.ailyFor = item.key;
    checkbox.checked = state.selectedRunIds.has(item.key);

    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      if (checkbox.checked) {
        state.selectedRunIds.add(item.key);
        item.row.classList.add(ROW_MARK_CLASS);
      } else {
        state.selectedRunIds.delete(item.key);
        item.row.classList.remove(ROW_MARK_CLASS);
      }
      updateToolbar();
    });

    return checkbox;
  }

  function scanRunRows() {
    ensureToolbar();
    state.mode = "run-list";
    state.spanNodes.clear();

    const rows = collectRunRows();
    const liveKeys = new Set(rows.map((item) => item.key));
    state.runRows = new Map(rows.map((item) => [item.key, item]));

    for (const key of Array.from(state.selectedRunIds)) {
      if (!liveKeys.has(key)) {
        state.selectedRunIds.delete(key);
      }
    }

    for (const item of rows) {
      const firstCell = item.row.firstElementChild;
      if (!firstCell) {
        continue;
      }
      const selector = `.${CHECKBOX_CLASS}[data-aily-for="${CSS.escape(item.key)}"]`;
      const existing = firstCell.querySelector(selector);
      if (!existing) {
        firstCell.insertBefore(createRunCheckbox(item), firstCell.firstChild);
      } else {
        existing.checked = state.selectedRunIds.has(item.key);
      }
      item.row.classList.toggle(ROW_MARK_CLASS, state.selectedRunIds.has(item.key));
    }

    updateToolbar();
  }

  function getSpanRow(element) {
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const text = getRowText(current);
      const rect = current.getBoundingClientRect();
      if (text && rect.width > 60 && rect.height <= 72 && spanTextPattern.test(text)) {
        return current;
      }
      current = current.parentElement;
    }
    return element;
  }

  function getSpanRowText(element) {
    return getRowText(getSpanRow(element));
  }

  function getSpanDurationText(element) {
    const match = getSpanRowText(element).match(durationPattern);
    return match ? match[1] : "";
  }

  function isExcludedSpanCandidate(element) {
    if (element.closest(`#${APP_ID}`)) {
      return true;
    }
    const excluded = element.closest(
      [
        "[data-testid^='common__Header']",
        "[data-testid^='common__ChatPanel']",
        "[data-testid='chat-panel-resize-handle']",
        "[data-testid='sidebar-collapse-toggle']",
        "[data-testid^='builder-nav-']",
        "input",
        "textarea"
      ].join(",")
    );
    if (excluded) {
      return true;
    }
    const label = getElementLabel(element);
    return /^(发布|复制|日志|运行日志|点赞|点踩|折叠|使用渠道)$/.test(label);
  }

  function isSpanCandidate(element) {
    if (!isRuntimeLogDetailPage() || !isElementVisible(element) || isExcludedSpanCandidate(element)) {
      return false;
    }

    const label = getElementLabel(element);
    if (!label || label.length > 80) {
      return false;
    }

    if (spanLabelPattern.test(label)) {
      return true;
    }

    const rowText = getSpanRowText(element);
    return rowText.length <= 160 && spanTextPattern.test(rowText) && durationPattern.test(rowText);
  }

  function collectSpanCandidates() {
    const elements = Array.from(document.querySelectorAll("button,[role='button']")).filter(isSpanCandidate);
    const counters = new Map();
    const candidates = [];

    for (const element of elements) {
      const label = getElementLabel(element);
      const count = (counters.get(label) || 0) + 1;
      counters.set(label, count);
      const key = `${label}#${count}`;
      const row = getSpanRow(element);

      element.setAttribute(SPAN_ATTR, key);
      candidates.push({
        key,
        label,
        element,
        row,
        rowText: getSpanRowText(element),
        durationText: getSpanDurationText(element)
      });
    }

    return candidates;
  }

  function createSpanCheckbox(candidate) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = CHECKBOX_CLASS;
    checkbox.title = "选择此 span 用于 JSON 导出";
    checkbox.setAttribute("aria-label", `选择 ${candidate.label}`);
    checkbox.dataset.ailyFor = candidate.key;
    checkbox.checked = state.selectedSpanKeys.has(candidate.key);

    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      if (checkbox.checked) {
        state.selectedSpanKeys.add(candidate.key);
        candidate.row.classList.add(ROW_MARK_CLASS);
      } else {
        state.selectedSpanKeys.delete(candidate.key);
        candidate.row.classList.remove(ROW_MARK_CLASS);
      }
      updateToolbar();
    });

    return checkbox;
  }

  function scanSpanNodes() {
    ensureToolbar();
    state.mode = "run-detail";
    state.runRows.clear();

    const candidates = collectSpanCandidates();
    const liveKeys = new Set(candidates.map((item) => item.key));
    state.spanNodes = new Map(candidates.map((item) => [item.key, item]));

    for (const key of Array.from(state.selectedSpanKeys)) {
      if (!liveKeys.has(key)) {
        state.selectedSpanKeys.delete(key);
      }
    }

    for (const candidate of candidates) {
      const parent = candidate.element.parentElement;
      if (!parent) {
        continue;
      }
      const selector = `.${CHECKBOX_CLASS}[data-aily-for="${CSS.escape(candidate.key)}"]`;
      const existing = parent.querySelector(selector);
      if (!existing) {
        parent.insertBefore(createSpanCheckbox(candidate), candidate.element);
      } else {
        existing.checked = state.selectedSpanKeys.has(candidate.key);
      }
      candidate.row.classList.toggle(ROW_MARK_CLASS, state.selectedSpanKeys.has(candidate.key));
    }

    updateToolbar();
  }

  function scanPage() {
    if (!isRuntimeLogPage()) {
      removeToolbar();
      return;
    }

    if (isRuntimeLogListPage()) {
      scanRunRows();
    } else {
      scanSpanNodes();
    }
  }

  function scheduleScan() {
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
    }
    state.scanTimer = setTimeout(scanPage, 250);
  }

  function ensureToolbar() {
    if (state.toolbarHost && document.documentElement.contains(state.toolbarHost)) {
      return;
    }

    const host = document.createElement("div");
    host.id = APP_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          bottom: 88px;
          right: 24px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .panel {
          width: 286px;
          border: 1px solid rgba(15, 23, 42, 0.14);
          border-radius: 8px;
          background: #ffffff;
          box-shadow: 0 10px 32px rgba(15, 23, 42, 0.16);
          color: #1f2329;
          overflow: hidden;
        }
        .panel.collapsed {
          width: 48px;
          height: 48px;
          border-radius: 999px;
          border-color: rgba(15, 118, 110, 0.42);
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid #eef0f3;
          font-size: 13px;
          font-weight: 600;
          cursor: move;
          user-select: none;
        }
        .panel.collapsed .header {
          width: 48px;
          height: 48px;
          padding: 0;
          border-bottom: 0;
          justify-content: center;
          cursor: pointer;
        }
        .panel.collapsed [data-role="title"],
        .panel.collapsed .body {
          display: none;
        }
        .body {
          display: grid;
          gap: 8px;
          padding: 10px 12px 12px;
        }
        .count {
          font-size: 12px;
          color: #646a73;
        }
        .actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
        }
        button {
          border: 1px solid #d0d5dd;
          border-radius: 6px;
          background: #fff;
          color: #1f2329;
          cursor: pointer;
          font: inherit;
          font-size: 12px;
          height: 30px;
          padding: 0 8px;
        }
        button:hover {
          background: #f7f8fa;
        }
        button.primary {
          grid-column: span 2;
          border-color: #0f766e;
          background: #0f766e;
          color: #fff;
        }
        button.primary:hover {
          background: #0b5f59;
        }
        button.icon {
          width: 24px;
          height: 24px;
          padding: 0;
          border: 0;
          color: #646a73;
          cursor: pointer;
        }
        .panel.collapsed button.icon {
          width: 48px;
          height: 48px;
          border-radius: 999px;
          background: #0f766e;
          color: #fff;
          font-size: 15px;
          font-weight: 700;
        }
        button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }
        button.wide {
          grid-column: span 2;
        }
        .status {
          min-height: 16px;
          font-size: 12px;
          line-height: 16px;
          color: #646a73;
        }
      </style>
      <section class="panel collapsed" aria-label="Aily runtime log exporter">
        <div class="header" data-role="drag-handle">
          <span data-role="title">Aily Trace ID 导出</span>
          <button class="icon" type="button" data-action="collapse" title="展开导出面板">导</button>
        </div>
        <div class="body">
          <div class="count" data-role="count">已选择 0 / 0</div>
          <div class="actions">
            <button type="button" data-action="select-all">全选本页</button>
            <button type="button" data-action="clear">清空</button>
            <button class="primary" type="button" data-action="export">导出选中 ZIP</button>
            <button class="wide" type="button" data-action="deep-export">深度 ZIP 导出</button>
            <button class="wide" type="button" data-action="open-download" disabled>打开下载位置</button>
          </div>
          <div class="status" data-role="status">等待选择 trace ID</div>
        </div>
      </section>
    `;

    shadow.addEventListener("click", (event) => {
      const action = event.target && event.target.dataset && event.target.dataset.action;
      if (!action) {
        return;
      }
      if (action === "select-all") {
        selectAll();
      } else if (action === "clear") {
        clearSelection();
      } else if (action === "export") {
        exportSelected();
      } else if (action === "deep-export") {
        exportDeepZip();
      } else if (action === "open-download") {
        openLastDownload();
      } else if (action === "collapse") {
        toggleToolbar(shadow);
      }
    });
    installToolbarDrag(host, shadow);

    document.documentElement.appendChild(host);
    state.toolbarHost = host;
    state.toolbar = shadow;
  }

  function removeToolbar() {
    if (state.toolbarHost) {
      state.toolbarHost.remove();
      state.toolbarHost = null;
      state.toolbar = null;
    }
  }

  function toggleToolbar(shadow) {
    const panel = shadow.querySelector(".panel");
    const button = shadow.querySelector("[data-action='collapse']");
    const collapsed = panel.classList.toggle("collapsed");
    button.textContent = collapsed ? "导" : "-";
    button.title = collapsed ? "展开导出面板" : "收起为浮动按钮";
  }

  function installToolbarDrag(host, shadow) {
    const handle = shadow.querySelector("[data-role='drag-handle']");
    if (!handle) {
      return;
    }

    let drag = null;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    handle.addEventListener("pointerdown", (event) => {
      if (event.target && event.target.dataset && event.target.dataset.action) {
        return;
      }
      const rect = host.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const nextLeft = clamp(drag.left + event.clientX - drag.startX, 8, window.innerWidth - drag.width - 8);
      const nextTop = clamp(drag.top + event.clientY - drag.startY, 8, window.innerHeight - drag.height - 8);
      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    });

    handle.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      drag = null;
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (_) {
        // Ignore if the browser already released capture.
      }
    });
  }

  function setStatus(message) {
    if (!state.toolbar) {
      return;
    }
    const status = state.toolbar.querySelector("[data-role='status']");
    if (status) {
      status.textContent = message;
    }
  }

  function updateToolbar() {
    if (!state.toolbar) {
      return;
    }

    const isList = state.mode === "run-list";
    const selected = isList ? state.selectedRunIds.size : state.selectedSpanKeys.size;
    const total = isList ? state.runRows.size : state.spanNodes.size;
    const itemName = isList ? "trace ID" : "span";
    const title = state.toolbar.querySelector("[data-role='title']");
    const count = state.toolbar.querySelector("[data-role='count']");
    const exportButton = state.toolbar.querySelector("[data-action='export']");
    const deepButton = state.toolbar.querySelector("[data-action='deep-export']");
    const openButton = state.toolbar.querySelector("[data-action='open-download']");

    if (title) {
      title.textContent = isList ? "Aily Trace ID 导出" : "Aily Span 导出";
    }
    if (count) {
      count.textContent = isList
        ? `已选择 ${selected} / ${total} 个 ${itemName}`
        : `已选择 ${selected} / ${total} 个 ${itemName}；未选择时导出当前 trace`;
    }
    if (exportButton) {
      exportButton.textContent = isList ? "导出选中 ZIP" : selected > 0 ? "导出所选 Span ZIP" : "导出当前 ZIP";
      exportButton.disabled = state.exporting || (isList && selected === 0);
    }
    if (deepButton) {
      deepButton.style.display = isList ? "none" : "";
      deepButton.disabled = state.exporting || isList;
    }
    if (openButton) {
      openButton.disabled = !state.lastExportZipFileName;
    }
  }

  function selectAll() {
    if (state.mode === "run-list") {
      for (const key of state.runRows.keys()) {
        state.selectedRunIds.add(key);
      }
      scanRunRows();
      setStatus(`已选择 ${state.selectedRunIds.size} 个 trace ID`);
      return;
    }

    for (const key of state.spanNodes.keys()) {
      state.selectedSpanKeys.add(key);
    }
    scanSpanNodes();
    setStatus(`已选择 ${state.selectedSpanKeys.size} 个 span`);
  }

  function clearSelection() {
    state.selectedRunIds.clear();
    state.selectedSpanKeys.clear();
    scanPage();
    setStatus("已清空选择");
  }

  function fingerprintDetails() {
    const params = getRuntimeParams();
    const text = cleanText(document.body.innerText || "");
    const inputIndex = text.indexOf("\nInput\n");
    const outputIndex = text.indexOf("\nOutput\n");
    return `${params.runId}|${params.spanId}|${inputIndex}|${outputIndex}|${text.length}`;
  }

  async function waitForDetailChange(previousFingerprint) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < DETAIL_WAIT_MS) {
      await sleep(120);
      if (fingerprintDetails() !== previousFingerprint) {
        return;
      }
    }
  }

  async function waitForRunDetailReady(runId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < RUN_DETAIL_TIMEOUT_MS) {
      const params = getRuntimeParams();
      const text = cleanText(document.body.innerText || "");
      if (
        params.runId === runId &&
        /运行日志/.test(text) &&
        (/运行总览/.test(text) || /Input/.test(text) || /Output/.test(text))
      ) {
        await sleep(500);
        return;
      }
      await sleep(250);
    }
  }

  function extractSection(text, startLabel, endLabel) {
    const start = text.search(new RegExp(`(^|\\n)${startLabel}(\\n|$)`));
    if (start < 0) {
      return "";
    }
    const startText = text.slice(start).replace(new RegExp(`^\\n?${startLabel}\\n?`), "");
    if (!endLabel) {
      return cleanText(startText);
    }
    const end = startText.search(new RegExp(`(^|\\n)${endLabel}(\\n|$)`));
    return cleanText(end < 0 ? startText : startText.slice(0, end));
  }

  function extractDetailText() {
    const fullText = cleanText(document.body.innerText || "");
    const inputIndex = fullText.search(/(^|\n)Input(\n|$)/);
    const detailStart =
      inputIndex > 0
        ? Math.max(
            fullText.lastIndexOf("\n运行总览", inputIndex),
            fullText.lastIndexOf("\nLLM 思考", inputIndex),
            fullText.lastIndexOf("\n工具调用", inputIndex),
            fullText.lastIndexOf("\n运行日志", inputIndex),
            0
          )
        : Math.max(fullText.lastIndexOf("\n运行日志"), 0);
    return cleanText(fullText.slice(detailStart));
  }

  function extractActiveDetails(metadata) {
    const detailText = extractDetailText();
    const inputText = extractSection(detailText, "Input", "Output");
    const outputText = extractSection(detailText, "Output");
    const summaryText = inputText
      ? cleanText(detailText.slice(0, detailText.indexOf("Input")))
      : cleanText(detailText.slice(0, 3000));

    return {
      source: "dom-visible",
      summaryText,
      input: {
        text: inputText
      },
      output: {
        text: outputText
      },
      metadata,
      text: detailText
    };
  }

  function inferSpanType(label) {
    if (/LLM|deepseek/i.test(label)) {
      return "llm";
    }
    if (/tool|bash|get_skills|技能|工具调用/i.test(label)) {
      return "tool";
    }
    if (/运行总览/i.test(label)) {
      return "overview";
    }
    return "span";
  }

  function sanitizePathSegment(value, maxLength) {
    const sanitized = String(value || "untitled")
      .replace(/[\\/:*?"<>|#%{}^~[\]`;]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength || 80)
      .replace(/[. ]+$/g, "");
    return sanitized || "untitled";
  }

  function padIndex(index) {
    return String(index + 1).padStart(2, "0");
  }

  function joinZipPath(prefix, filePath) {
    return [prefix, filePath]
      .filter(Boolean)
      .join("/")
      .replace(/\/{2,}/g, "/")
      .replace(/^\/+/, "");
  }

  function stringifyJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  function addTextFile(files, path, content) {
    files.push({
      path,
      content: String(content || "")
    });
  }

  function addJsonFile(files, path, value) {
    addTextFile(files, path, stringifyJson(value));
  }

  function parseMaybeJsonValue(value) {
    if (typeof value !== "string") {
      return { ok: true, value };
    }
    const trimmed = value.trim();
    if (!trimmed || !/^[{[]/.test(trimmed)) {
      return { ok: false, value };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (_) {
      return { ok: false, value };
    }
  }

  function normalizePossiblyJsonField(value) {
    const parsed = parseMaybeJsonValue(value);
    return parsed.ok ? parsed.value : value;
  }

  function valueToReadableText(value) {
    if (typeof value === "string") {
      return value.endsWith("\n") ? value : `${value}\n`;
    }
    if (Array.isArray(value)) {
      const messageLike = value.filter((item) => item && typeof item === "object" && "content" in item);
      if (messageLike.length > 0) {
        return messageLike
          .map((item, index) => {
            const title = [item.role, item.type, item.status].filter(Boolean).join(" / ") || `item ${index + 1}`;
            return `## ${index + 1}. ${title}\n\n${item.content || stringifyJson(item)}\n`;
          })
          .join("\n");
      }
    }
    if (value && typeof value === "object" && Array.isArray(value.messages)) {
      return value.messages
        .map((message, index) => {
          const title = [message.role, message.type].filter(Boolean).join(" / ") || `message ${index + 1}`;
          return `## ${index + 1}. ${title}\n\n${message.content || stringifyJson(message)}\n`;
        })
        .join("\n");
    }
    return stringifyJson(value);
  }

  function addStructuredValueFiles(files, basePath, name, value) {
    if (value === undefined || value === null || value === "") {
      return;
    }
    const parsed = parseMaybeJsonValue(value);
    if (parsed.ok) {
      addJsonFile(files, `${basePath}/${name}.json`, parsed.value);
      const readable = valueToReadableText(parsed.value);
      if (readable.trim()) {
        addTextFile(files, `${basePath}/${name}.md`, readable);
      }
      return;
    }
    addTextFile(files, `${basePath}/${name === "output" ? "output.md" : `${name}.txt`}`, valueToReadableText(value));
  }

  function isRuntimeLogUrl(url) {
    let pathname = String(url || "");
    try {
      pathname = new URL(url).pathname;
    } catch (_) {
      // Keep the original string.
    }
    return (
      /\/anyclaw\/agent\/api\/v\d+\/agents\/[^/]+\/agent_runs(?:\/|$)/i.test(pathname) ||
      /\/agent_runs(?:\/|$)/i.test(pathname) ||
      /\/runtime[-_]?logs?(?:\/|$)/i.test(pathname) ||
      /\/trace_tree(?:\/|$)/i.test(pathname) ||
      /\/spans\/[^/?#]+/i.test(pathname)
    );
  }

  function normalizeCapturedEvent(event) {
    const request = event.request || {};
    const response = event.response || {};
    const bodyFromLegacy = event.body === undefined ? "" : event.body;
    const legacyText = typeof bodyFromLegacy === "string" ? bodyFromLegacy : stringifyJson(bodyFromLegacy);
    const bodyText = response.bodyText || legacyText;
    const bodyJson =
      response.bodyJson !== undefined
        ? response.bodyJson
        : typeof bodyFromLegacy === "object" && bodyFromLegacy !== null
          ? bodyFromLegacy
          : safeJsonParse(bodyText);
    return {
      ...event,
      request: {
        url: request.url || event.url || "",
        method: request.method || event.method || "GET",
        body: request.body || "",
        headers: request.headers || {}
      },
      response: {
        url: response.url || event.url || "",
        status: response.status === undefined ? event.status : response.status,
        statusText: response.statusText || "",
        headers: response.headers || {},
        bodyText,
        bodyJson,
        truncated: Boolean(response.truncated || event.truncated)
      }
    };
  }

  function normalizeHeaderMap(headers) {
    const output = {};
    if (!headers || typeof headers !== "object") {
      return output;
    }
    Object.entries(headers).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        output[String(key).toLowerCase()] = String(value);
      }
    });
    return output;
  }

  function rememberRuntimeRequestHeaders(headers) {
    const nextHeaders = normalizeHeaderMap(headers);
    if (Object.keys(nextHeaders).length === 0) {
      return;
    }
    state.runtimeRequestHeaders = {
      ...state.runtimeRequestHeaders,
      ...nextHeaders
    };
  }

  function buildRuntimeFetchHeaders(url) {
    const headers = normalizeHeaderMap(state.runtimeRequestHeaders);
    if (!headers.accept) {
      headers.accept = "application/json, text/plain, */*";
    }
    if (/\/spans\/[^/?#]+|\/trace_tree(?:\?|$)/i.test(String(url || "")) && !headers["x-requested-with"]) {
      headers["x-requested-with"] = "XMLHttpRequest";
    }
    return headers;
  }

  async function fetchRuntimeJson(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: buildRuntimeFetchHeaders(url)
    });
    const bodyText = await response.text();
    const bodyJson = safeJsonParse(bodyText);
    return {
      url,
      response,
      bodyText,
      bodyJson
    };
  }

  function pushSyntheticRuntimeResponse({ url, method, status, statusText, bodyText, bodyJson, source, matchReasons }) {
    state.rawEvents.push({
      type: "response",
      capturedAt: new Date().toISOString(),
      source: source || "active-prefetch",
      matchReasons: matchReasons || ["active_runtime_log_prefetch"],
      request: {
        url,
        method: method || "GET",
        body: ""
      },
      response: {
        url,
        status,
        statusText: statusText || "",
        headers: {
          "content-type": "application/json"
        },
        bodyText,
        bodyJson,
        truncated: false
      },
      url,
      method: method || "GET",
      status,
      contentType: "application/json",
      truncated: false,
      body: bodyJson === undefined ? bodyText : bodyJson
    });
    state.lastCaptureAt = Date.now();
    if (state.rawEvents.length > MAX_RAW_EVENTS) {
      state.rawEvents.splice(0, state.rawEvents.length - MAX_RAW_EVENTS);
    }
  }

  function getRuntimeApiBase() {
    const params = getRuntimeParams();
    if (!params.agentId || !params.runId) {
      return "";
    }
    return `${location.origin}/anyclaw/agent/api/v1/agents/${encodeURIComponent(params.agentId)}/agent_runs/${encodeURIComponent(
      params.runId
    )}`;
  }

  function extractTraceTreeSpanIds(traceTreeBody) {
    const spans = traceTreeBody?.data?.spans || [];
    return [...new Set(spans.map((span) => span && (span.span_id || span.spanID)).filter(Boolean))];
  }

  function findCachedTraceTreeBody() {
    for (const event of state.rawEvents.slice().reverse()) {
      const normalized = normalizeCapturedEvent(event);
      const url = normalized.request.url || normalized.response.url || "";
      const bodyJson = normalized.response.bodyJson;
      if (/\/trace_tree(?:\/|\?|$)/i.test(url) && Array.isArray(bodyJson?.data?.spans)) {
        return bodyJson;
      }
    }
    return null;
  }

  function hasCachedSpanDetail(spanId) {
    return state.rawEvents.some((event) => {
      const normalized = normalizeCapturedEvent(event);
      const detail = normalized.response.bodyJson?.data?.detail;
      const detailSpanId = detail?.span_id || detail?.spanID;
      if (detailSpanId === spanId) {
        return true;
      }
      return /\/spans\/[^/?#]+/i.test(normalized.request.url || "") && (normalized.request.url || "").includes(spanId);
    });
  }

  async function mapLimit(items, limit, mapper) {
    const results = [];
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  async function prefetchSpanDetailsFromTraceTree(mode) {
    if (!isRuntimeLogDetailPage()) {
      return {
        mode,
        attempted: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        reason: "not_runtime_detail_page"
      };
    }

    const baseUrl = getRuntimeApiBase();
    if (!baseUrl) {
      return {
        mode,
        attempted: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        reason: "missing_runtime_params"
      };
    }

    const traceTreeUrl = `${baseUrl}/trace_tree`;
    let traceTree = null;
    let traceTreeError = "";
    try {
      traceTree = await fetchRuntimeJson(traceTreeUrl);
      pushSyntheticRuntimeResponse({
        url: traceTreeUrl,
        status: traceTree.response.status,
        statusText: traceTree.response.statusText,
        bodyText: traceTree.bodyText,
        bodyJson: traceTree.bodyJson,
        source: "active-trace-tree-prefetch"
      });
    } catch (error) {
      traceTreeError = error && error.message ? error.message : String(error);
    }

    const cachedTraceTreeBody = findCachedTraceTreeBody();
    const usedActiveTraceTree = Boolean(traceTree?.response.ok && Array.isArray(traceTree.bodyJson?.data?.spans));
    const traceTreeBody = usedActiveTraceTree ? traceTree.bodyJson : cachedTraceTreeBody;

    if (!traceTreeBody) {
      return {
        mode,
        attempted: 0,
        success: 0,
        failed: 1,
        skipped: 0,
        traceTreeStatus: traceTree?.response.status || 0,
        error: traceTreeError || undefined
      };
    }

    const spanIds = extractTraceTreeSpanIds(traceTreeBody);
    const missingSpanIds = spanIds.filter((spanId) => !hasCachedSpanDetail(spanId));
    let success = 0;
    let failed = 0;

    await mapLimit(missingSpanIds, SPAN_DETAIL_PREFETCH_CONCURRENCY, async (spanId) => {
      const spanUrl = `${baseUrl}/spans/${encodeURIComponent(spanId)}`;
      try {
        const detail = await fetchRuntimeJson(spanUrl);
        pushSyntheticRuntimeResponse({
          url: spanUrl,
          status: detail.response.status,
          statusText: detail.response.statusText,
          bodyText: detail.bodyText,
          bodyJson: detail.bodyJson,
          source: "active-span-detail-prefetch"
        });
        if (detail.response.ok && detail.bodyJson) {
          success += 1;
        } else {
          failed += 1;
        }
      } catch (_) {
        failed += 1;
      }
    });

    return {
      mode,
      attempted: missingSpanIds.length,
      success,
      failed,
      skipped: spanIds.length - missingSpanIds.length,
      traceTreeStatus: traceTree?.response.status || 0,
      traceTreeSource: usedActiveTraceTree ? "active-prefetch" : "cached-runtime-response",
      traceSpanCount: spanIds.length
    };
  }

  function entryContainsCurrentPageIds(entry, pageParts) {
    const bodyText = entry.response?.bodyText || "";
    const haystack = [entry.request?.url || "", entry.response?.url || "", bodyText].join("\n");
    return Boolean(
      (pageParts.runId && haystack.includes(pageParts.runId)) ||
        (pageParts.spanId && haystack.includes(pageParts.spanId))
    );
  }

  function isRuntimeLogEntry(entry, pageParts) {
    const url = entry.request?.url || entry.response?.url || "";
    if (!isRuntimeLogUrl(url)) {
      return false;
    }
    if (!pageParts.runId && !pageParts.spanId) {
      return true;
    }
    return entryContainsCurrentPageIds(entry, pageParts);
  }

  function extractRuntimeLog(runtimeResponses) {
    const traceTrees = [];
    const spanDetails = [];
    const runLists = [];
    const otherRuntimeResponses = [];

    for (const entry of runtimeResponses) {
      const url = entry.request?.url || entry.response?.url || "";
      if (/\/trace_tree(?:\/|$)/i.test(url)) {
        traceTrees.push(entry);
      } else if (/\/spans\/[^/?#]+/i.test(url)) {
        spanDetails.push(entry);
      } else if (/\/agent_runs\/list(?:\?|$)/i.test(url) || /\/agent_runs\/list$/i.test(url)) {
        runLists.push(entry);
      } else {
        otherRuntimeResponses.push(entry);
      }
    }

    const traceSpans = traceTrees.flatMap((entry) => entry.response.bodyJson?.data?.spans || []);
    const detailBySpanId = {};
    for (const entry of spanDetails) {
      const detail = entry.response.bodyJson?.data?.detail;
      const spanId =
        detail?.span_id ||
        detail?.spanID ||
        (entry.request?.url || "").match(/\/spans\/([^/?#]+)/)?.[1] ||
        "";
      if (spanId) {
        detailBySpanId[spanId] = detail || entry.response.bodyJson;
      }
    }

    return {
      summary: {
        rawRuntimeResponseCount: runtimeResponses.length,
        traceTreeCount: traceTrees.length,
        runListCount: runLists.length,
        spanDetailCount: spanDetails.length,
        traceSpanCount: traceSpans.length,
        spanDetailIds: Object.keys(detailBySpanId)
      },
      traceSpans,
      detailBySpanId,
      traceTrees,
      runLists,
      otherRuntimeResponses
    };
  }

  function buildTreeNodes(traceSpans, detailBySpanId) {
    const byId = new Map();
    const roots = [];

    function ensureNode(span) {
      const spanId = span.span_id || span.spanID;
      if (!spanId) {
        return null;
      }
      if (!byId.has(spanId)) {
        byId.set(spanId, { span, children: [] });
      } else {
        byId.get(spanId).span = { ...byId.get(spanId).span, ...span };
      }
      return byId.get(spanId);
    }

    for (const span of traceSpans || []) {
      ensureNode(span);
    }
    for (const [spanId, detail] of Object.entries(detailBySpanId || {})) {
      ensureNode({ ...detail, span_id: detail.span_id || detail.spanID || spanId });
    }
    for (const node of byId.values()) {
      const span = node.span;
      const parentId = span.parent_span_id || span.parentSpanID || span.parent_spanID;
      if (parentId && parentId !== "0" && byId.has(parentId)) {
        byId.get(parentId).children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortNodes = (nodes) => {
      nodes.sort((a, b) => {
        const startDiff =
          Number(a.span.start_time_ms || a.span.startTimeMs || 0) -
          Number(b.span.start_time_ms || b.span.startTimeMs || 0);
        if (startDiff !== 0) {
          return startDiff;
        }
        return String(a.span.display_name || "").localeCompare(String(b.span.display_name || ""));
      });
      nodes.forEach((node) => sortNodes(node.children));
    };
    sortNodes(roots);
    return roots;
  }

  function getSpanId(span) {
    return String(span?.span_id || span?.spanID || "");
  }

  function getSpanTraceId(span) {
    const metadata = span?.metadata || {};
    return String(
      span?.trace_id ||
        span?.traceID ||
        metadata.trace_id ||
        metadata.traceId ||
        metadata.agentRunID ||
        metadata.agentRunId ||
        metadata.agent_run_id ||
        ""
    );
  }

  function treeContainsSpanId(node, targetSpanId) {
    if (!node || !targetSpanId) {
      return false;
    }
    if (getSpanId(node.span) === targetSpanId) {
      return true;
    }
    return node.children.some((child) => treeContainsSpanId(child, targetSpanId));
  }

  function collectTreeSpanIds(node, output) {
    if (!node) {
      return;
    }
    const spanId = getSpanId(node.span);
    if (spanId) {
      output.add(spanId);
    }
    node.children.forEach((child) => collectTreeSpanIds(child, output));
  }

  function filterRootsForCurrentPage(roots, pageParts) {
    if ((!pageParts.runId && !pageParts.spanId) || roots.length === 0) {
      return roots;
    }
    const matchedRoots = roots.filter((node) => {
      const rootSpanId = getSpanId(node.span);
      const rootTraceId = getSpanTraceId(node.span);
      return Boolean(
        (pageParts.runId && rootTraceId === pageParts.runId) ||
          (pageParts.spanId && (rootSpanId === pageParts.spanId || treeContainsSpanId(node, pageParts.spanId)))
      );
    });
    return matchedRoots.length > 0 ? matchedRoots : roots;
  }

  function filterRuntimeLogForCurrentPage(runtimeLog, pageParts) {
    const detailBySpanId = runtimeLog.detailBySpanId || {};
    const roots = filterRootsForCurrentPage(buildTreeNodes(runtimeLog.traceSpans || [], detailBySpanId), pageParts);
    const allowedSpanIds = new Set();
    roots.forEach((node) => collectTreeSpanIds(node, allowedSpanIds));
    if (allowedSpanIds.size === 0) {
      return runtimeLog;
    }
    const filteredDetailBySpanId = {};
    allowedSpanIds.forEach((spanId) => {
      if (detailBySpanId[spanId]) {
        filteredDetailBySpanId[spanId] = detailBySpanId[spanId];
      }
    });
    return {
      ...runtimeLog,
      summary: {
        ...(runtimeLog.summary || {}),
        traceSpanCount: allowedSpanIds.size,
        spanDetailCount: Object.keys(filteredDetailBySpanId).length,
        spanDetailIds: Object.keys(filteredDetailBySpanId),
        rootCount: roots.length
      },
      traceSpans: (runtimeLog.traceSpans || []).filter((span) => allowedSpanIds.has(getSpanId(span))),
      detailBySpanId: filteredDetailBySpanId
    };
  }

  function childSummary(node) {
    return {
      span_id: node.span.span_id || node.span.spanID || "",
      display_name: node.span.display_name || "",
      span_type: node.span.span_type || "",
      status: node.span.status || "",
      duration_ms: node.span.duration_ms
    };
  }

  function treeNodeJson(node) {
    return {
      ...childSummary(node),
      parent_span_id: node.span.parent_span_id || node.span.parentSpanID || "",
      start_time_ms: node.span.start_time_ms,
      children: node.children.map(treeNodeJson)
    };
  }

  function spanJsonForFile(span, detail, children) {
    const merged = { ...span, ...detail };
    return {
      ...merged,
      input: normalizePossiblyJsonField(merged.input),
      output: normalizePossiblyJsonField(merged.output),
      children: children.map(childSummary)
    };
  }

  function spanLabel(span, index) {
    return `${padIndex(index)}-${sanitizePathSegment(span.display_name || span.name || "span", 64)}`;
  }

  function spanFileName(span) {
    return `${sanitizePathSegment(span.display_name || span.name || "span", 80)}.json`;
  }

  function addSpanFolder(files, node, parentPath, index, detailBySpanId) {
    const span = node.span;
    const spanId = span.span_id || span.spanID || "";
    const detail = detailBySpanId[spanId] || {};
    const merged = { ...span, ...detail };
    const dirPath = parentPath ? `${parentPath}/${spanLabel(merged, index)}` : spanLabel(merged, index);
    addJsonFile(files, `${dirPath}/${spanFileName(merged)}`, spanJsonForFile(span, detail, node.children));
    addStructuredValueFiles(files, dirPath, "input", merged.input);
    addStructuredValueFiles(files, dirPath, "output", merged.output);
    node.children.forEach((child, childIndex) => {
      addSpanFolder(files, child, dirPath, childIndex, detailBySpanId);
    });
  }

  function rawResponseFileName(entry, index, detailBySpanId) {
    const url = entry.request?.url || entry.response?.url || "";
    const spanMatch = url.match(/\/spans\/([^/?#]+)/);
    if (spanMatch) {
      const spanId = spanMatch[1];
      const displayName = entry.response?.bodyJson?.data?.detail?.display_name || detailBySpanId[spanId]?.display_name || spanId;
      return `spans/${padIndex(index)}_${sanitizePathSegment(displayName, 80)}.json`;
    }
    if (/\/trace_tree(?:\/|$)/i.test(url)) {
      return `${padIndex(index)}_trace_tree.json`;
    }
    if (/\/agent_runs\/list(?:\?|$)/i.test(url) || /\/agent_runs\/list$/i.test(url)) {
      return `${padIndex(index)}_agent_runs_list.json`;
    }
    return `${padIndex(index)}_runtime_response.json`;
  }

  function generateDiagnosticReport(data) {
    const meta = data.metadata || {};
    const duration = data.duration_ms === undefined ? "" : `${Number(data.duration_ms) / 1000} 秒`;
    const status = String(data.status) === "0" ? "成功" : data.status === undefined ? "未知" : "失败";
    const startTimeMs = Number(data.start_time_ms || data.startTimeMs || 0);
    const startTime = startTimeMs ? new Date(startTimeMs).toLocaleString("zh-CN", { hour12: false }) : "";
    const input = Array.isArray(data.input)
      ? data.input.map((item) => item.content || stringifyJson(item)).join("\n\n")
      : typeof data.input === "object" && data.input
        ? data.input.content || stringifyJson(data.input)
        : String(data.input || "");
    const output = valueToReadableText(data.output || "");
    const sequence = [
      "```mermaid",
      "sequenceDiagram",
      "    participant User as 用户",
      "    participant Agent as 主智能体",
      "    participant Tool as 工具",
      `    User->>Agent: ${input.slice(0, 40).replace(/\n/g, " ") || "输入"}`,
      "    Agent->>Tool: 运行与工具调用",
      "    Tool-->>Agent: 返回结果",
      "    Agent-->>User: 输出",
      "```"
    ].join("\n");

    return [
      "# Agent运行解读报告",
      "",
      "## 运行总览",
      `- 开始时间: ${startTime || "未知"}`,
      `- 运行时长: ${duration || "未知"}`,
      `- 最终状态: ${status}`,
      `- 消耗 Token: ${meta.total_tokens === undefined ? "未知" : meta.total_tokens}`,
      "",
      "## 运行时序图",
      sequence,
      "",
      "## 用户输入",
      "```text",
      input,
      "```",
      "",
      "## 输出内容",
      "```text",
      output,
      "```",
      ""
    ].join("\n");
  }

  function buildExportPayload(collection) {
    const pageParts = getRuntimeParams();
    const parsedResponses = state.rawEvents.map(normalizeCapturedEvent);
    const runtimeResponses = parsedResponses.filter((entry) => isRuntimeLogEntry(entry, pageParts));
    const runtimeLog = filterRuntimeLogForCurrentPage(extractRuntimeLog(runtimeResponses), pageParts);
    return {
      exporter: {
        name: "aily-runtime-log-exporter",
        version: "0.1.0"
      },
      page: {
        url: location.href,
        title: document.title,
        exportedAt: new Date().toISOString(),
        ...pageParts
      },
      capture: {
        responseCount: parsedResponses.length,
        runtimeResponseCount: runtimeResponses.length,
        domSnapshotCount: state.domSnapshots.length,
        truncatedResponseCount: parsedResponses.filter((entry) => entry.response?.truncated).length,
        note:
          runtimeResponses.length > 0
            ? "captured_runtime_log_responses_and_page_text_snapshots"
            : "no_network_response_captured; exported_visible_page_text"
      },
      collection: collection || null,
      runtimeLog,
      rawRuntimeResponses: runtimeResponses,
      pageTextSnapshots: state.domSnapshots.slice(),
      visibleTextAtDownload: getVisibleRuntimeText()
    };
  }

  function buildFolderFiles(payload, basePath) {
    const files = [];
    const runtimeLog = payload.runtimeLog || {};
    const detailBySpanId = runtimeLog.detailBySpanId || {};
    const roots = buildTreeNodes(runtimeLog.traceSpans || [], detailBySpanId);
    const prefix = basePath || "";

    addJsonFile(files, joinZipPath(prefix, "summary.json"), {
      exporter: payload.exporter,
      page: payload.page,
      capture: payload.capture,
      collection: payload.collection,
      runtimeLogSummary: runtimeLog.summary || {}
    });
    if (roots.length > 0) {
      addJsonFile(files, joinZipPath(prefix, "trace-tree.json"), roots.map(treeNodeJson));
    }

    const rootNodeForReport =
      roots.find((node) => node.span && (node.span.display_name === "运行总览" || node.span.name === "运行总览")) ||
      roots[0];
    if (rootNodeForReport) {
      const span = rootNodeForReport.span;
      const spanId = span.span_id || span.spanID || "";
      const detail = detailBySpanId[spanId] || {};
      addTextFile(
        files,
        joinZipPath(prefix, "Agent运行解读报告.md"),
        generateDiagnosticReport(spanJsonForFile(span, detail, rootNodeForReport.children))
      );
    }

    if (roots.length === 1) {
      const root = roots[0];
      const span = root.span;
      const spanId = span.span_id || span.spanID || "";
      const detail = detailBySpanId[spanId] || {};
      const merged = { ...span, ...detail };
      addJsonFile(files, joinZipPath(prefix, spanFileName(merged)), spanJsonForFile(span, detail, root.children));
      root.children.forEach((child, index) => {
        addSpanFolder(files, child, joinZipPath(prefix, ""), index, detailBySpanId);
      });
    } else {
      roots.forEach((node, index) => {
        addSpanFolder(files, node, prefix, index, detailBySpanId);
      });
    }

    if (roots.length === 0 && payload.visibleTextAtDownload) {
      addTextFile(files, joinZipPath(prefix, "visible-text.txt"), payload.visibleTextAtDownload);
    }

    payload.pageTextSnapshots.slice(0, 12).forEach((snapshot, index) => {
      addTextFile(
        files,
        joinZipPath(prefix, `page-text-snapshots/${padIndex(index)}-${sanitizePathSegment(snapshot.label, 50)}.txt`),
        snapshot.text
      );
    });

    payload.rawRuntimeResponses.slice(0, 24).forEach((entry, index) => {
      addJsonFile(
        files,
        joinZipPath(prefix, `raw-runtime-responses/${rawResponseFileName(entry, index, detailBySpanId)}`),
        entry
      );
    });

    return files;
  }

  function findRawMatches(runId, spanId) {
    const matches = [];

    for (const event of state.rawEvents.slice().reverse()) {
      const normalized = normalizeCapturedEvent(event);
      const haystack = [
        normalized.request.url || "",
        normalized.response.url || "",
        normalized.response.bodyText || "",
        JSON.stringify(event.body || "")
      ].join("\n");
      if ((spanId && haystack.includes(spanId)) || (runId && haystack.includes(runId))) {
        matches.push(normalized);
      }
      if (matches.length >= 8) {
        break;
      }
    }

    return matches.reverse();
  }

  function timestampForFilename() {
    return new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+/, "")
      .replace("T", "-");
  }

  function buildZipName(prefix, id) {
    return `${prefix}-${id || "runtime-log"}-${timestampForFilename()}`;
  }

  function makeCrc32Table() {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  const crc32Table = makeCrc32Table();

  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function u16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return bytes;
  }

  function u32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  }

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function createZipBlob(files, rootFolderName) {
    const encoder = new TextEncoder();
    const now = dosDateTime(new Date());
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const fileName = encoder.encode(`${rootFolderName}/${file.path}`.replace(/^\/+/, ""));
      const data = encoder.encode(file.content || "");
      const checksum = crc32(data);
      const localHeader = concatBytes([
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(now.dosTime),
        u16(now.dosDate),
        u32(checksum),
        u32(data.length),
        u32(data.length),
        u16(fileName.length),
        u16(0),
        fileName
      ]);
      localParts.push(localHeader, data);

      const centralHeader = concatBytes([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(now.dosTime),
        u16(now.dosDate),
        u32(checksum),
        u32(data.length),
        u32(data.length),
        u16(fileName.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        fileName
      ]);
      centralParts.push(centralHeader);
      offset += localHeader.length + data.length;
    }

    const centralDirectory = concatBytes(centralParts);
    const end = concatBytes([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(centralDirectory.length),
      u32(offset),
      u16(0)
    ]);

    return new Blob([concatBytes([...localParts, centralDirectory, end])], {
      type: "application/zip"
    });
  }

  function downloadZip(files, rootFolderName) {
    const safeRoot = sanitizePathSegment(rootFolderName, 140);
    const filename = `${safeRoot}.zip`;
    const blob = createZipBlob(files, safeRoot);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    state.lastExportZipFileName = filename;
    updateToolbar();
    return filename;
  }

  function openLastDownload() {
    if (!state.lastExportZipFileName) {
      setStatus("还没有可打开的导出 ZIP");
      return;
    }
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      setStatus("当前环境不支持打开下载位置");
      return;
    }
    chrome.runtime.sendMessage({
      type: "OPEN_DOWNLOADS_FOLDER",
      filename: state.lastExportZipFileName
    });
  }

  function isVisibleForDeepScan(element) {
    if (!element || element === document.documentElement || element === document.body) {
      return true;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 4 &&
      rect.height > 4 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity || 1) !== 0
    );
  }

  function isScrollable(element) {
    if (!element) {
      return false;
    }
    if (element === document.scrollingElement || element === document.documentElement || element === document.body) {
      return element.scrollHeight > window.innerHeight + 80;
    }
    const style = getComputedStyle(element);
    const scrollableY = /(auto|scroll|overlay)/.test(style.overflowY);
    const scrollableX = /(auto|scroll|overlay)/.test(style.overflowX);
    return (
      isVisibleForDeepScan(element) &&
      ((scrollableY && element.scrollHeight > element.clientHeight + 80) ||
        (scrollableX && element.scrollWidth > element.clientWidth + 80))
    );
  }

  function getScrollableElements() {
    const elements = [document.scrollingElement || document.documentElement];
    document.querySelectorAll("main,section,article,div,aside,[role='tree'],[role='tabpanel']").forEach((element) => {
      if (isScrollable(element)) {
        elements.push(element);
      }
    });
    const unique = [];
    const seen = new Set();
    for (const element of elements) {
      if (!element || seen.has(element)) {
        continue;
      }
      seen.add(element);
      unique.push(element);
    }
    return unique
      .sort((a, b) => b.scrollHeight * b.scrollWidth - a.scrollHeight * a.scrollWidth)
      .slice(0, 12);
  }

  function setElementScrollTop(element, top) {
    if (element === document.scrollingElement || element === document.documentElement || element === document.body) {
      window.scrollTo(window.scrollX, top);
    } else {
      element.scrollTop = top;
    }
  }

  function getElementScrollTop(element) {
    if (element === document.scrollingElement || element === document.documentElement || element === document.body) {
      return window.scrollY;
    }
    return element.scrollTop;
  }

  async function scrollElementAndSnapshot(element, label, maxSteps) {
    const originalTop = getElementScrollTop(element);
    const viewportHeight =
      element === document.scrollingElement || element === document.documentElement || element === document.body
        ? window.innerHeight
        : element.clientHeight;
    const maxTop = Math.max(0, element.scrollHeight - viewportHeight);
    const step = Math.max(160, Math.floor(viewportHeight * 0.85));
    let steps = 0;

    setElementScrollTop(element, 0);
    await sleep(120);
    captureDomSnapshot(`${label}:top`);
    for (let top = 0; top < maxTop && steps < maxSteps; top += step) {
      setElementScrollTop(element, Math.min(maxTop, top + step));
      await sleep(120);
      captureDomSnapshot(`${label}:scroll:${Math.min(maxTop, top + step)}`);
      steps += 1;
    }
    setElementScrollTop(element, originalTop);
    return steps;
  }

  function normalizeNodeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function looksLikeLogNodeText(text) {
    const normalized = normalizeNodeText(text);
    if (!normalized || normalized.length > 180) {
      return false;
    }
    return (
      /运行总览|意图识别|主\s*Agent|Agent\s*循环|LLM\s*思考|工具调用|Input|Output|mcp|bash|im_message|ms_|调用|总览|思考/.test(
        normalized
      ) || /\b\d+(?:\.\d+)?\s*(?:ms|s)\b/i.test(normalized)
    );
  }

  function findClickableLogNodes() {
    const candidates = [];
    const seen = new Set();
    const selector = "button,[role='button'],[role='treeitem'],[aria-expanded],a,[tabindex],div,span,li";
    document.querySelectorAll(selector).forEach((element) => {
      if (!isVisibleForDeepScan(element) || element.closest(`#${APP_ID}`)) {
        return;
      }
      const text = normalizeNodeText(element.innerText || element.textContent || "");
      if (!looksLikeLogNodeText(text)) {
        return;
      }
      const clickable = element.closest("button,[role='button'],[role='treeitem'],a,[tabindex]") || element;
      if (!isVisibleForDeepScan(clickable)) {
        return;
      }
      const rect = clickable.getBoundingClientRect();
      const key = `${text}|${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(
        rect.height
      )}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      candidates.push({ element: clickable, text });
    });
    return candidates.slice(0, 300);
  }

  async function expandVisibleCollapsedItems(maxRounds) {
    let clickCount = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const collapsed = Array.from(
        document.querySelectorAll(
          "details:not([open]) > summary,[aria-expanded='false'],button[title*='展开'],button[aria-label*='展开']"
        )
      ).filter((element) => isVisibleForDeepScan(element) && !element.closest(`#${APP_ID}`));
      if (collapsed.length === 0) {
        break;
      }
      for (const element of collapsed.slice(0, 80)) {
        try {
          element.scrollIntoView({ block: "center", inline: "nearest" });
          element.click();
          clickCount += 1;
          await sleep(80);
        } catch (_) {
          // Continue with the next candidate.
        }
      }
    }
    return clickCount;
  }

  async function resetToRootNode() {
    const nodes = findClickableLogNodes();
    for (const node of nodes) {
      if (node.text.includes("运行总览") || node.text.includes("Runtime Overview")) {
        try {
          node.element.scrollIntoView({ block: "center", inline: "nearest" });
          await sleep(80);
          node.element.click();
          await waitForNetworkQuiet(300, 1000);
          return true;
        } catch (_) {
          return false;
        }
      }
    }
    return false;
  }

  async function waitForNetworkQuiet(quietMs, maxMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxMs) {
      if (!state.lastCaptureAt || Date.now() - state.lastCaptureAt >= quietMs) {
        await sleep(quietMs);
        if (!state.lastCaptureAt || Date.now() - state.lastCaptureAt >= quietMs) {
          return;
        }
      }
      await sleep(120);
    }
  }

  async function collectRuntimeLogPayload(mode) {
    const stats = {
      mode: mode || "network_and_dom",
      startedAt: new Date().toISOString(),
      expandedClickCount: 0,
      scrolledElementCount: 0,
      scrollStepCount: 0,
      clickedNodeCount: 0,
      responseCountBefore: state.rawEvents.length,
      domSnapshotCountBefore: state.domSnapshots.length
    };

    captureDomSnapshot("initial");
    let prefetchStats = null;
    if (mode === "current_zip_export" || mode === "deep_zip_export" || mode === "batch_zip_export") {
      setStatus(mode === "deep_zip_export" ? "深度导出中：正在通过接口补齐 span 详情" : "正在通过接口补齐 span 详情");
      try {
        prefetchStats = await prefetchSpanDetailsFromTraceTree(mode);
      } catch (error) {
        prefetchStats = {
          mode,
          attempted: 0,
          success: 0,
          failed: 1,
          skipped: 0,
          error: error && error.message ? error.message : String(error)
        };
      }
    }

    if (mode === "deep_zip_export") {
      if (prefetchStats && prefetchStats.traceSpanCount && prefetchStats.success + prefetchStats.skipped >= prefetchStats.traceSpanCount) {
        setStatus("深度导出中：接口详情已补齐，跳过页面点击");
      } else {
        setStatus("深度导出中：正在回到根节点");
        await resetToRootNode();
        setStatus("深度导出中：正在展开日志节点");
        stats.expandedClickCount += await expandVisibleCollapsedItems(3);
        await waitForNetworkQuiet(400, 1500);
        captureDomSnapshot("after_expand");

        setStatus("深度导出中：正在滚动日志区域");
        const scrollables = getScrollableElements();
        stats.scrolledElementCount = scrollables.length;
        for (let index = 0; index < scrollables.length; index += 1) {
          stats.scrollStepCount += await scrollElementAndSnapshot(scrollables[index], `scrollable_${index + 1}`, 36);
          await waitForNetworkQuiet(250, 900);
        }

        setStatus("深度导出中：正在读取每个日志详情");
        const nodes = findClickableLogNodes();
        for (const node of nodes) {
          try {
            node.element.scrollIntoView({ block: "center", inline: "nearest" });
            await sleep(80);
            node.element.click();
            stats.clickedNodeCount += 1;
            await waitForNetworkQuiet(350, 1300);
            await expandVisibleCollapsedItems(1);
            captureDomSnapshot(`clicked:${node.text}`);
          } catch (_) {
            // Continue with the next candidate.
          }
        }
      }
    }

    await waitForNetworkQuiet(500, 1500);
    captureDomSnapshot("before_download");
    stats.endedAt = new Date().toISOString();
    stats.responseCountAfter = state.rawEvents.length;
    stats.domSnapshotCountAfter = state.domSnapshots.length;
    stats.prefetch = prefetchStats;
    return buildExportPayload(stats);
  }

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  function readJob() {
    if (hasChromeStorage()) {
      return new Promise((resolve) => {
        chrome.storage.local.get(JOB_KEY, (items) => {
          resolve(items && items[JOB_KEY] ? items[JOB_KEY] : null);
        });
      });
    }

    try {
      return Promise.resolve(JSON.parse(sessionStorage.getItem(JOB_KEY) || "null"));
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function writeJob(job) {
    if (hasChromeStorage()) {
      return new Promise((resolve) => {
        chrome.storage.local.set({ [JOB_KEY]: job }, resolve);
      });
    }

    sessionStorage.setItem(JOB_KEY, JSON.stringify(job));
    return Promise.resolve();
  }

  function removeJob() {
    if (hasChromeStorage()) {
      return new Promise((resolve) => {
        chrome.storage.local.remove(JOB_KEY, resolve);
      });
    }

    sessionStorage.removeItem(JOB_KEY);
    return Promise.resolve();
  }

  function getRunPayloadFromRow(item) {
    return {
      runId: item.runId,
      traceId: item.traceId,
      detailUrl: item.detailUrl,
      listRow: {
        statusText: item.statusText,
        environment: item.environment,
        user: item.user,
        startTime: item.startTime,
        channel: item.channel,
        traceId: item.traceId,
        conversationId: item.conversationId,
        quota: item.quota,
        durationText: item.durationText,
        version: item.version,
        cells: item.cells,
        rowText: item.rowText
      }
    };
  }

  async function exportSelectedRuns() {
    scanRunRows();
    const runs = Array.from(state.selectedRunIds)
      .map((key) => state.runRows.get(key))
      .filter(Boolean)
      .map(getRunPayloadFromRow);

    if (!runs.length) {
      setStatus("请先选择 trace ID");
      return;
    }

    state.exporting = true;
    updateToolbar();

    const job = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "run-list-batch",
      startedAt: new Date().toISOString(),
      listUrl: location.href,
      agentId: getRuntimeParams().agentId,
      index: 0,
      runs,
      results: []
    };

    await writeJob(job);
    setStatus(`开始导出 ${runs.length} 个 trace ID ZIP`);
    location.href = runs[0].detailUrl;
    window.setTimeout(() => {
      state.exporting = false;
      resumeBatchJob();
    }, 1500);
  }

  function extractCurrentRunDetail(listRun) {
    const params = getRuntimeParams();
    const spanSummaries = collectSpanCandidates().map((candidate) => ({
      label: candidate.label,
      type: inferSpanType(candidate.label),
      durationText: candidate.durationText,
      rowText: candidate.rowText
    }));
    const details = extractActiveDetails({
      runId: params.runId,
      traceId: params.runId,
      sourceListRow: listRun ? listRun.listRow : null
    });
    const raw = findRawMatches(params.runId, params.spanId);

    return {
      runId: params.runId,
      traceId: params.runId,
      spanId: params.spanId || "",
      detailUrl: location.href,
      capturedAt: new Date().toISOString(),
      source: raw.length ? "network-cache+dom-visible" : details.source,
      listRow: listRun ? listRun.listRow : null,
      summaryText: details.summaryText,
      input: details.input,
      output: details.output,
      spans: spanSummaries,
      raw,
      text: details.text
    };
  }

  async function resumeBatchJob() {
    if (state.resumingJob || state.exporting || !isRuntimeLogPage()) {
      return;
    }

    const job = await readJob();
    if (!job || job.type !== "run-list-batch") {
      return;
    }

    if (!isRuntimeLogDetailPage()) {
      if (job.runs[job.index]) {
        location.href = job.runs[job.index].detailUrl;
      }
      return;
    }

    state.resumingJob = true;
    state.exporting = true;
    ensureToolbar();
    updateToolbar();

    try {
      let currentJob = job;
      let expected = currentJob.runs[currentJob.index];
      const params = getRuntimeParams();

      if (!expected || expected.runId !== params.runId) {
        const matchingIndex = currentJob.runs.findIndex((run) => run.runId === params.runId);
        if (matchingIndex >= 0) {
          currentJob.index = matchingIndex;
          expected = currentJob.runs[matchingIndex];
        }
      }

      if (!expected) {
        await removeJob();
        setStatus("批量导出队列为空");
        return;
      }

      if (expected.runId !== getRuntimeParams().runId) {
        await writeJob(currentJob);
        location.href = expected.detailUrl;
        return;
      }

      setStatus(`采集中 ${currentJob.index + 1}/${currentJob.runs.length}: ${expected.traceId}`);
      await waitForRunDetailReady(expected.runId);

      const tracePayload = await collectRuntimeLogPayload("batch_zip_export");
      const traceFolder = sanitizePathSegment(`trace-${expected.traceId}`, 120);
      currentJob.results.push({
        traceId: expected.traceId,
        runId: expected.runId,
        detailUrl: location.href,
        files: buildFolderFiles(
          {
            ...tracePayload,
            collection: {
              ...(tracePayload.collection || {}),
              sourceListRow: expected.listRow
            }
          },
          traceFolder
        )
      });
      currentJob.index += 1;
      currentJob.updatedAt = new Date().toISOString();

      if (currentJob.index < currentJob.runs.length) {
        const next = currentJob.runs[currentJob.index];
        await writeJob(currentJob);
        setStatus(`继续导出 ${currentJob.index + 1}/${currentJob.runs.length}`);
        location.href = next.detailUrl;
        return;
      }

      const payload = {
        exportedAt: new Date().toISOString(),
        startedAt: currentJob.startedAt,
        listUrl: currentJob.listUrl,
        pageUrl: location.href,
        agentId: currentJob.agentId,
        selectedCount: currentJob.runs.length,
        traceIds: currentJob.runs.map((run) => run.traceId),
        results: currentJob.results.map((result) => ({
          traceId: result.traceId,
          runId: result.runId,
          detailUrl: result.detailUrl,
          fileCount: result.files.length
        }))
      };
      const files = [];
      addJsonFile(files, "batch-summary.json", payload);
      for (const result of currentJob.results) {
        files.push(...result.files);
      }

      await removeJob();
      downloadZip(files, buildZipName("aily-runtime-logs", `${payload.selectedCount}-traceids`));
      setStatus(`已导出 ${payload.selectedCount} 个 trace ID ZIP`);
    } catch (error) {
      const jobOnError = await readJob();
      if (jobOnError) {
        jobOnError.errors = jobOnError.errors || [];
        jobOnError.errors.push({
          at: new Date().toISOString(),
          url: location.href,
          message: error && error.message ? error.message : String(error)
        });
        await writeJob(jobOnError);
      }
      setStatus(`导出失败: ${error && error.message ? error.message : String(error)}`);
    } finally {
      state.exporting = false;
      state.resumingJob = false;
      updateToolbar();
    }
  }

  async function exportSelectedSpans() {
    scanSpanNodes();
    const selectedKeys = Array.from(state.selectedSpanKeys);

    if (!selectedKeys.length) {
      await exportCurrentTraceZip(false);
      return;
    }

    state.exporting = true;
    updateToolbar();

    const originalUrl = location.href;
    const initialParams = getRuntimeParams();
    const traces = [];

    try {
      for (let index = 0; index < selectedKeys.length; index += 1) {
        scanSpanNodes();
        const candidate = state.spanNodes.get(selectedKeys[index]);
        if (!candidate || !document.documentElement.contains(candidate.element)) {
          continue;
        }

        setStatus(`采集中 ${index + 1}/${selectedKeys.length}: ${candidate.label}`);
        const before = fingerprintDetails();
        candidate.element.click();
        await waitForDetailChange(before);
        await sleep(180);

        const params = getRuntimeParams();
        const details = extractActiveDetails({
          label: candidate.label,
          rowText: candidate.rowText
        });
        const raw = findRawMatches(params.runId, params.spanId);

        traces.push({
          runId: params.runId || "",
          traceId: params.runId || "",
          spanId: params.spanId || "",
          label: candidate.label,
          type: inferSpanType(candidate.label),
          durationText: candidate.durationText,
          source: raw.length ? "network-cache+dom-visible" : details.source,
          summaryText: details.summaryText,
          input: details.input,
          output: details.output,
          metadata: details.metadata,
          raw
        });
      }

      const payload = {
        exportedAt: new Date().toISOString(),
        pageUrl: originalUrl,
        agentId: initialParams.agentId,
        runId: initialParams.runId,
        traceId: initialParams.runId,
        selectedCount: traces.length,
        traces
      };
      const files = [];
      addJsonFile(files, "summary.json", payload);
      traces.forEach((trace, index) => {
        const basePath = `selected-spans/${padIndex(index)}-${sanitizePathSegment(trace.label, 64)}`;
        addJsonFile(files, `${basePath}/${sanitizePathSegment(trace.label, 80)}.json`, trace);
        addStructuredValueFiles(files, basePath, "input", trace.input?.text || trace.input);
        addStructuredValueFiles(files, basePath, "output", trace.output?.text || trace.output);
      });

      downloadZip(files, buildZipName("aily-runtime-log-spans", initialParams.runId));
      setStatus(`已导出 ${traces.length} 个 span ZIP`);
    } catch (error) {
      setStatus(`导出失败: ${error && error.message ? error.message : String(error)}`);
    } finally {
      state.exporting = false;
      updateToolbar();
    }
  }

  async function exportCurrentTraceZip(deep) {
    state.exporting = true;
    updateToolbar();
    try {
      setStatus(deep ? "开始深度 ZIP 导出" : "开始导出当前 ZIP");
      const params = getRuntimeParams();
      const payload = await collectRuntimeLogPayload(deep ? "deep_zip_export" : "current_zip_export");
      const files = buildFolderFiles(payload);
      downloadZip(files, buildZipName("aily-runtime-log", params.runId || "runtime-log"));
      setStatus(deep ? "已完成深度 ZIP 导出" : "已导出当前 ZIP");
    } catch (error) {
      setStatus(`导出失败: ${error && error.message ? error.message : String(error)}`);
    } finally {
      state.exporting = false;
      updateToolbar();
    }
  }

  function exportDeepZip() {
    if (state.exporting || !isRuntimeLogDetailPage()) {
      return;
    }
    exportCurrentTraceZip(true);
  }

  function exportSelected() {
    if (state.exporting) {
      return;
    }
    if (state.mode === "run-list") {
      exportSelectedRuns();
    } else {
      exportSelectedSpans();
    }
  }

  function injectPageHook() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) {
        return;
      }
      if (document.documentElement.querySelector("script[data-aily-runtime-log-hook]")) {
        return;
      }
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("src/page-hook.js");
      script.async = false;
      script.dataset.ailyRuntimeLogHook = "true";
      (document.head || document.documentElement).appendChild(script);
      script.addEventListener("load", () => script.remove(), { once: true });
    } catch (_) {
      // The DOM fallback remains useful even if the page hook cannot be injected.
    }
  }

  function onHookMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== HOOK_SOURCE) {
      return;
    }
    const payload = event.data.payload;
    if (!payload || payload.type !== "response") {
      return;
    }
    const { runtimeRequestHeaders, ...capturedPayload } = payload;
    rememberRuntimeRequestHeaders(runtimeRequestHeaders);
    state.rawEvents.push(capturedPayload);
    state.lastCaptureAt = Date.now();
    if (state.rawEvents.length > MAX_RAW_EVENTS) {
      state.rawEvents.splice(0, state.rawEvents.length - MAX_RAW_EVENTS);
    }
  }

  function installMessageBridge() {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) {
      return;
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || !message.type) {
        return false;
      }
      if (message.type === "AILY_EXPORT_SELECTED") {
        Promise.resolve(exportSelected()).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (message.type === "AILY_EXPORT_CURRENT_ZIP") {
        Promise.resolve(exportCurrentTraceZip(false)).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (message.type === "AILY_EXPORT_DEEP_ZIP") {
        Promise.resolve(exportCurrentTraceZip(true)).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (message.type === "AILY_RESCAN") {
        scanPage();
        sendResponse({
          ok: true,
          selected: state.mode === "run-list" ? state.selectedRunIds.size : state.selectedSpanKeys.size,
          traces: state.mode === "run-list" ? state.runRows.size : state.spanNodes.size,
          mode: state.mode,
          runtimeLogPage: isRuntimeLogPage()
        });
        return false;
      }
      if (message.type === "AILY_STATUS") {
        sendResponse({
          ok: true,
          selected: state.mode === "run-list" ? state.selectedRunIds.size : state.selectedSpanKeys.size,
          traces: state.mode === "run-list" ? state.runRows.size : state.spanNodes.size,
          mode: state.mode,
          runtimeLogPage: isRuntimeLogPage(),
          runId: getRuntimeParams().runId,
          lastExportZipFileName: state.lastExportZipFileName
        });
        return false;
      }
      return false;
    });
  }

  function boot() {
    if (state.booted) {
      return;
    }
    state.booted = true;
    injectPageHook();
    window.addEventListener("message", onHookMessage);
    installMessageBridge();

    state.observer = new MutationObserver(scheduleScan);
    const startObserver = () => {
      state.observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
      scheduleScan();
      window.setTimeout(resumeBatchJob, 1000);
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    } else {
      startObserver();
    }

    window.addEventListener("popstate", () => {
      scheduleScan();
      window.setTimeout(resumeBatchJob, 500);
    });
    window.setInterval(() => {
      if (isRuntimeLogPage()) {
        scheduleScan();
        resumeBatchJob();
      }
    }, 2000);
  }

  window.__ailyRuntimeLogExporter = {
    scan: scanPage,
    exportSelected,
    getState: () => ({
      selected: state.mode === "run-list" ? state.selectedRunIds.size : state.selectedSpanKeys.size,
      traces: state.mode === "run-list" ? state.runRows.size : state.spanNodes.size,
      rawEvents: state.rawEvents.length,
      mode: state.mode,
      runtimeLogPage: isRuntimeLogPage(),
      lastExportZipFileName: state.lastExportZipFileName
    })
  };

  boot();
})();
