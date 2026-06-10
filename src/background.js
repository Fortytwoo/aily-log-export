function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "OPEN_DOWNLOADS_FOLDER") {
    return false;
  }

  const filename = String(message.filename || "").trim();
  const searchOptions = filename
    ? {
        filenameRegex: `(^|[\\\\/])${escapeRegex(filename)}$`,
        orderBy: ["-startTime"],
        limit: 1
      }
    : {
        orderBy: ["-startTime"],
        limit: 1
      };

  chrome.downloads.search(searchOptions, (results) => {
    if (results && results.length > 0 && results[0].state === "complete") {
      chrome.downloads.show(results[0].id);
    } else {
      chrome.downloads.showDefaultFolder();
    }
  });
  sendResponse({ ok: true });
  return true;
});
