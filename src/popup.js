(function () {
  "use strict";

  const statusEl = document.getElementById("status");
  const exportButton = document.getElementById("export");
  const rescanButton = document.getElementById("rescan");

  function setStatus(text) {
    statusEl.textContent = text;
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function sendToActiveTab(message) {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      throw new Error("未找到当前标签页");
    }
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function refreshStatus() {
    try {
      const result = await sendToActiveTab({ type: "AILY_STATUS" });
      if (!result || !result.runtimeLogPage) {
        exportButton.disabled = true;
        setStatus("请打开飞书 Aily 运行日志页");
        return;
      }
      exportButton.disabled = result.selected === 0;
      setStatus(`run_id: ${result.runId || "-"}，已选择 ${result.selected}/${result.traces}`);
    } catch (_) {
      exportButton.disabled = true;
      setStatus("页面未就绪，请刷新运行日志页");
    }
  }

  rescanButton.addEventListener("click", async () => {
    setStatus("正在扫描页面 trace...");
    try {
      await sendToActiveTab({ type: "AILY_RESCAN" });
      await refreshStatus();
    } catch (error) {
      setStatus(error && error.message ? error.message : "扫描失败");
    }
  });

  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    setStatus("正在导出选中 trace...");
    try {
      await sendToActiveTab({ type: "AILY_EXPORT_SELECTED" });
      window.close();
    } catch (error) {
      setStatus(error && error.message ? error.message : "导出失败");
      exportButton.disabled = false;
    }
  });

  refreshStatus();
})();

