(function () {
  "use strict";

  const APP_ID = "aily-runtime-log-exporter";
  const HOOK_SOURCE = "aily-runtime-log-exporter-hook";
  const CHECKBOX_CLASS = "aily-log-export-checkbox";
  const ROW_MARK_CLASS = "aily-log-export-row-mark";
  const RUN_ATTR = "data-aily-log-export-run-id";
  const SPAN_ATTR = "data-aily-log-export-span-key";
  const JOB_KEY = "ailyRuntimeLogExportJobV2";
  const MAX_RAW_EVENTS = 120;
  const DETAIL_WAIT_MS = 1400;
  const RUN_DETAIL_TIMEOUT_MS = 30000;

  const state = {
    selectedRunIds: new Set(),
    selectedSpanKeys: new Set(),
    runRows: new Map(),
    spanNodes: new Map(),
    rawEvents: [],
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
            <button class="primary" type="button" data-action="export">导出选中 JSON</button>
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

    if (title) {
      title.textContent = isList ? "Aily Trace ID 导出" : "Aily Span 导出";
    }
    if (count) {
      count.textContent = `已选择 ${selected} / ${total} 个 ${itemName}`;
    }
    if (exportButton) {
      exportButton.disabled = state.exporting || selected === 0;
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

  function findRawMatches(runId, spanId) {
    const matches = [];

    for (const event of state.rawEvents.slice().reverse()) {
      const haystack = `${event.url || ""}\n${JSON.stringify(event.body || "")}`;
      if ((spanId && haystack.includes(spanId)) || (runId && haystack.includes(runId))) {
        matches.push(event);
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

  function buildFilename(prefix, id) {
    return `${prefix}-${id || "batch"}-${timestampForFilename()}.json`;
  }

  function downloadJson(payload, filename) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
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
    setStatus(`开始导出 ${runs.length} 个 trace ID`);
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

      currentJob.results.push(extractCurrentRunDetail(expected));
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
        logs: currentJob.results
      };

      await removeJob();
      downloadJson(payload, buildFilename("aily-runtime-logs", `${payload.selectedCount}-traceids`));
      setStatus(`已导出 ${payload.selectedCount} 个 trace ID`);
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
      setStatus("请先选择 span");
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

      downloadJson(payload, buildFilename("aily-runtime-log-spans", initialParams.runId));
      setStatus(`已导出 ${traces.length} 个 span`);
    } catch (error) {
      setStatus(`导出失败: ${error && error.message ? error.message : String(error)}`);
    } finally {
      state.exporting = false;
      updateToolbar();
    }
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
    state.rawEvents.push(payload);
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
          runId: getRuntimeParams().runId
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
      runtimeLogPage: isRuntimeLogPage()
    })
  };

  boot();
})();
