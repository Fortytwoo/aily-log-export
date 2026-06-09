(function () {
  "use strict";

  const SOURCE = "aily-runtime-log-exporter-hook";
  const MAX_BODY_LENGTH = 5 * 1024 * 1024;

  if (window.__ailyRuntimeLogExporterHookInstalled) {
    return;
  }

  window.__ailyRuntimeLogExporterHookInstalled = true;

  const shouldCaptureUrl = (rawUrl) => {
    try {
      const url = new URL(String(rawUrl), location.href);
      if (url.hostname !== location.hostname) {
        return false;
      }
      return /(runtime|trace|span|run|log|conversation|message|chat)/i.test(
        `${url.pathname}${url.search}`
      );
    } catch (_) {
      return false;
    }
  };

  const postCapture = (payload) => {
    window.postMessage({ source: SOURCE, payload }, location.origin);
  };

  const safeJsonParse = (text) => {
    try {
      return JSON.parse(text);
    } catch (_) {
      return undefined;
    }
  };

  const captureText = async ({ url, method, status, contentType, bodyText }) => {
    if (!shouldCaptureUrl(url) || typeof bodyText !== "string") {
      return;
    }

    const truncated = bodyText.length > MAX_BODY_LENGTH;
    const text = truncated ? bodyText.slice(0, MAX_BODY_LENGTH) : bodyText;
    const parsed = /json/i.test(contentType || "") ? safeJsonParse(text) : undefined;

    postCapture({
      type: "response",
      capturedAt: new Date().toISOString(),
      url,
      method: method || "GET",
      status,
      contentType: contentType || "",
      truncated,
      body: parsed === undefined ? text : parsed
    });
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input && input.url;
        const method =
          (init && init.method) ||
          (input && input.method) ||
          "GET";
        if (url && shouldCaptureUrl(url)) {
          const clone = response.clone();
          const contentType = clone.headers.get("content-type") || "";
          const bodyText = await clone.text();
          await captureText({
            url: new URL(url, location.href).href,
            method,
            status: clone.status,
            contentType,
            bodyText
          });
        }
      } catch (_) {
        // Capture is best-effort and must never affect the page request.
      }
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__ailyRuntimeLogExporter = {
      method: method || "GET",
      url: url ? new URL(String(url), location.href).href : ""
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend() {
    try {
      this.addEventListener("load", function onLoad() {
        try {
          const meta = this.__ailyRuntimeLogExporter || {};
          if (!meta.url || !shouldCaptureUrl(meta.url)) {
            return;
          }
          if (this.responseType && this.responseType !== "text" && this.responseType !== "json") {
            return;
          }
          const responseText =
            typeof this.responseText === "string"
              ? this.responseText
              : typeof this.response === "string"
                ? this.response
                : "";
          captureText({
            url: meta.url,
            method: meta.method,
            status: this.status,
            contentType: this.getResponseHeader("content-type") || "",
            bodyText: responseText
          });
        } catch (_) {
          // Capture is best-effort and must never affect the page request.
        }
      });
    } catch (_) {
      // Ignore pages that prevent XHR listener registration.
    }
    return originalSend.apply(this, arguments);
  };
})();

