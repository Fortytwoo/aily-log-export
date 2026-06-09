(function () {
  "use strict";

  const APP_ID = "aily-runtime-log-exporter";
  const HOOK_SOURCE = "aily-runtime-log-exporter-hook";
  const TRACE_NODE_ATTR = "data-aily-log-export-key";
  const CHECKBOX_CLASS = "aily-log-export-checkbox";
  const ROW_MARK_CLASS = "aily-log-export-row-mark";
  const MAX_RAW_EVENTS = 120;
  const DETAIL_WAIT_MS = 1400;

  const state = {
    selectedKeys: new Set(),
    traceNodes: new Map(),
    rawEvents: [],
    observer: null,
    toolbarHost: null,
    toolbar: null,
    scanTimer: null,
    exporting: false,
    booted: false
  };

  const traceLabelPattern =
    /^(运行总览|意图识别|主\s*Agent\s*循环|LLM\s*思考|工具调用|逻辑结束|get_skills|bash|tool|技能|deepseek[-_\w]*|.+Agent.*)$/i;
  const traceTextPattern =
    /(运行总览|意图识别|主\s*Agent\s*循环|LLM\s*思考|工具调用|逻辑结束|get_skills|bash|deepseek|工具调用|\btool\b)/i;
  const durationPattern = /(\d+(?:\.\d+)?\s*(?:ms|s|min|秒|分钟))/i;

  function isRuntimeLogPage() {
    return location.hostname === "feishu.cn" && /\/builder\/runtime-log\/?$/.test(location.pathname);
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

  function getRowText(element) {
    const row = getTraceRow(element);
    return cleanText((row && row.innerText) || element.innerText || element.textContent || "");
  }

  function getDurationText(element) {
    const rowText = getRowText(element);
    const match = rowText.match(durationPattern);
    return match ? match[1] : "";
  }

  function getTraceRow(element) {
    let current = element;
    for (let depth = 0; current && depth < 4; depth += 1) {
      const text = cleanText(current.innerText || current.textContent || "");
      const rect = current.getBoundingClientRect();
      if (text && rect.width > 60 && rect.height <= 72 && traceTextPattern.test(text)) {
        return current;
      }
      current = current.parentElement;
    }
    return element;
  }

  function isExcludedCandidate(element) {
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

  function isTraceCandidate(element) {
    if (!isRuntimeLogPage() || !isElementVisible(element) || isExcludedCandidate(element)) {
      return false;
    }

    const label = getElementLabel(element);
    if (!label || label.length > 80) {
      return false;
    }

    if (traceLabelPattern.test(label)) {
      return true;
    }

    const rowText = getRowText(element);
    return rowText.length <= 160 && traceTextPattern.test(rowText) && durationPattern.test(rowText);
  }

  function collectTraceCandidates() {
    const elements = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter(isTraceCandidate);
    const counters = new Map();
    const candidates = [];

    for (const element of elements) {
      const label = getElementLabel(element);
      const count = (counters.get(label) || 0) + 1;
      counters.set(label, count);
      const key = `${label}#${count}`;
      const row = getTraceRow(element);

      element.setAttribute(TRACE_NODE_ATTR, key);
      candidates.push({
        key,
        label,
        element,
        row,
        durationText: getDurationText(element)
      });
    }

    return candidates;
  }

  function createCheckbox(candidate) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = CHECKBOX_CLASS;
    checkbox.title = "选择此 trace 用于 JSON 导出";
    checkbox.setAttribute("aria-label", `选择 ${candidate.label}`);
    checkbox.dataset.ailyFor = candidate.key;
    checkbox.checked = state.selectedKeys.has(candidate.key);

    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      if (checkbox.checked) {
        state.selectedKeys.add(candidate.key);
        candidate.row.classList.add(ROW_MARK_CLASS);
      } else {
        state.selectedKeys.delete(candidate.key);
        candidate.row.classList.remove(ROW_MARK_CLASS);
      }
      updateToolbar();
    });

    return checkbox;
  }

  function scanTraceNodes() {
    if (!isRuntimeLogPage()) {
      removeToolbar();
      return;
    }

    ensureToolbar();
    const candidates = collectTraceCandidates();
    const liveKeys = new Set(candidates.map((item) => item.key));
    state.traceNodes = new Map(candidates.map((item) => [item.key, item]));

    for (const key of Array.from(state.selectedKeys)) {
      if (!liveKeys.has(key)) {
        state.selectedKeys.delete(key);
      }
    }

    for (const candidate of candidates) {
      const parent = candidate.element.parentElement;
      if (!parent) {
        continue;
      }

      const existing = parent.querySelector(`.${CHECKBOX_CLASS}[data-aily-for="${CSS.escape(candidate.key)}"]`);
      if (!existing) {
        const checkbox = createCheckbox(candidate);
        parent.insertBefore(checkbox, candidate.element);
      } else {
        existing.checked = state.selectedKeys.has(candidate.key);
      }

      candidate.row.classList.toggle(ROW_MARK_CLASS, state.selectedKeys.has(candidate.key));
    }

    updateToolbar();
  }

  function scheduleScan() {
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
    }
    state.scanTimer = setTimeout(scanTraceNodes, 250);
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
          top: 72px;
          right: 24px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .panel {
          width: 272px;
          border: 1px solid rgba(15, 23, 42, 0.14);
          border-radius: 8px;
          background: #ffffff;
          box-shadow: 0 10px 32px rgba(15, 23, 42, 0.16);
          color: #1f2329;
          overflow: hidden;
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
      <section class="panel" aria-label="Aily runtime log exporter">
        <div class="header">
          <span>Aily 日志导出</span>
          <button class="icon" type="button" data-action="collapse" title="收起">-</button>
        </div>
        <div class="body">
          <div class="count" data-role="count">已选择 0 / 0</div>
          <div class="actions">
            <button type="button" data-action="select-all">全选</button>
            <button type="button" data-action="clear">清空</button>
            <button class="primary" type="button" data-action="export">导出选中 JSON</button>
          </div>
          <div class="status" data-role="status">等待选择 trace</div>
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
        exportSelectedTraces();
      } else if (action === "collapse") {
        toggleToolbar(shadow);
      }
    });

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
    const body = shadow.querySelector(".body");
    const button = shadow.querySelector("[data-action='collapse']");
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "grid" : "none";
    button.textContent = hidden ? "-" : "+";
    button.title = hidden ? "收起" : "展开";
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
    const count = state.toolbar.querySelector("[data-role='count']");
    const exportButton = state.toolbar.querySelector("[data-action='export']");
    if (count) {
      count.textContent = `已选择 ${state.selectedKeys.size} / ${state.traceNodes.size}`;
    }
    if (exportButton) {
      exportButton.disabled = state.exporting || state.selectedKeys.size === 0;
    }
  }

  function selectAll() {
    for (const key of state.traceNodes.keys()) {
      state.selectedKeys.add(key);
    }
    scanTraceNodes();
    setStatus(`已选择 ${state.selectedKeys.size} 个 trace`);
  }

  function clearSelection() {
    state.selectedKeys.clear();
    scanTraceNodes();
    setStatus("已清空选择");
  }

  function fingerprintDetails() {
    const params = getRuntimeParams();
    const text = cleanText(document.body.innerText || "");
    const inputIndex = text.indexOf("\nInput\n");
    const outputIndex = text.indexOf("\nOutput\n");
    return `${params.spanId}|${inputIndex}|${outputIndex}|${text.length}`;
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

  function extractActiveDetails(candidate) {
    const fullText = cleanText(document.body.innerText || "");
    const inputIndex = fullText.search(/(^|\n)Input(\n|$)/);
    const detailStart =
      inputIndex > 0
        ? Math.max(fullText.lastIndexOf("\n运行总览", inputIndex), fullText.lastIndexOf("\nLLM 思考", inputIndex), fullText.lastIndexOf("\n工具调用", inputIndex), 0)
        : 0;
    const detailText = cleanText(fullText.slice(detailStart));
    const inputText = extractSection(detailText, "Input", "Output");
    const outputText = extractSection(detailText, "Output");
    const summaryText = inputText
      ? cleanText(detailText.slice(0, detailText.indexOf("Input")))
      : cleanText(detailText.slice(0, 2000));

    return {
      source: "dom-visible",
      summaryText,
      input: {
        text: inputText
      },
      output: {
        text: outputText
      },
      metadata: {
        label: candidate.label,
        rowText: getRowText(candidate.element)
      },
      text: detailText
    };
  }

  function inferType(label) {
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

  function findRawMatches(spanId) {
    const params = getRuntimeParams();
    const runId = params.runId;
    const matches = [];

    for (const event of state.rawEvents.slice().reverse()) {
      const haystack = `${event.url || ""}\n${JSON.stringify(event.body || "")}`;
      if ((spanId && haystack.includes(spanId)) || (runId && haystack.includes(runId))) {
        matches.push(event);
      }
      if (matches.length >= 6) {
        break;
      }
    }

    return matches.reverse();
  }

  function buildFilename(runId) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+/, "")
      .replace("T", "-");
    return `aily-runtime-log-${runId || "run"}-${stamp}.json`;
  }

  function downloadJson(payload) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = buildFilename(payload.runId);
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportSelectedTraces() {
    if (state.exporting) {
      return;
    }

    scanTraceNodes();
    const selectedKeys = Array.from(state.selectedKeys);

    if (!selectedKeys.length) {
      setStatus("请先选择 trace");
      return;
    }

    state.exporting = true;
    updateToolbar();

    const originalUrl = location.href;
    const initialParams = getRuntimeParams();
    const traces = [];

    try {
      for (let index = 0; index < selectedKeys.length; index += 1) {
        scanTraceNodes();
        const candidate = state.traceNodes.get(selectedKeys[index]);
        if (!candidate || !document.documentElement.contains(candidate.element)) {
          continue;
        }

        setStatus(`采集中 ${index + 1}/${selectedKeys.length}: ${candidate.label}`);
        const before = fingerprintDetails();
        candidate.element.click();
        await waitForDetailChange(before);
        await sleep(180);

        const params = getRuntimeParams();
        const details = extractActiveDetails(candidate);
        const raw = findRawMatches(params.spanId);

        traces.push({
          spanId: params.spanId || "",
          label: candidate.label,
          type: inferType(candidate.label),
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
        selectedCount: traces.length,
        traces
      };

      downloadJson(payload);
      setStatus(`已导出 ${traces.length} 个 trace`);
    } catch (error) {
      setStatus(`导出失败: ${error && error.message ? error.message : String(error)}`);
    } finally {
      state.exporting = false;
      updateToolbar();
    }
  }

  function injectPageHook() {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.getURL) {
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
        exportSelectedTraces().then(() => sendResponse({ ok: true }));
        return true;
      }
      if (message.type === "AILY_RESCAN") {
        scanTraceNodes();
        sendResponse({
          ok: true,
          selected: state.selectedKeys.size,
          traces: state.traceNodes.size,
          runtimeLogPage: isRuntimeLogPage()
        });
        return false;
      }
      if (message.type === "AILY_STATUS") {
        sendResponse({
          ok: true,
          selected: state.selectedKeys.size,
          traces: state.traceNodes.size,
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
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    } else {
      startObserver();
    }

    window.addEventListener("popstate", scheduleScan);
    window.setInterval(() => {
      if (isRuntimeLogPage()) {
        scheduleScan();
      }
    }, 2000);
  }

  window.__ailyRuntimeLogExporter = {
    scan: scanTraceNodes,
    exportSelected: exportSelectedTraces,
    getState: () => ({
      selected: state.selectedKeys.size,
      traces: state.traceNodes.size,
      rawEvents: state.rawEvents.length,
      runtimeLogPage: isRuntimeLogPage()
    })
  };

  boot();
})();
