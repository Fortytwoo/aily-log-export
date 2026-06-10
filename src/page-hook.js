(function () {
  "use strict";

  const SOURCE = "aily-runtime-log-exporter-hook";
  const MAX_BODY_LENGTH = 10 * 1024 * 1024;
  const REUSABLE_REQUEST_HEADER_NAMES = new Set([
    "accept",
    "content-type",
    "x-requested-with",
    "x-csrftoken",
    "x-csrf-token",
    "x-xsrftoken",
    "x-xsrf-token",
    "x-secsdk-csrf-token",
    "x-lark-csrf-token"
  ]);
  const SENSITIVE_REQUEST_HEADER_PATTERN = /(^authorization$|^cookie$|csrf|xsrf|token|session|credential|secret)/i;

  if (window.__ailyRuntimeLogExporterHookInstalled) {
    return;
  }

  window.__ailyRuntimeLogExporterHookInstalled = true;

  const getCurrentPageSignals = () => {
    const params = new URLSearchParams(location.search);
    return {
      runId: params.get("run_id") || "",
      spanId: params.get("span_id") || ""
    };
  };

  const normalizedUrl = (rawUrl) => {
    try {
      return new URL(String(rawUrl || ""), location.href).href;
    } catch (_) {
      return String(rawUrl || "");
    }
  };

  const headersToObject = (headers) => {
    const output = {};
    if (!headers) {
      return output;
    }
    try {
      if (typeof headers.forEach === "function") {
        headers.forEach((value, key) => {
          output[String(key).toLowerCase()] = value;
        });
        return output;
      }
      if (Array.isArray(headers)) {
        headers.forEach((pair) => {
          if (Array.isArray(pair) && pair.length >= 2) {
            output[String(pair[0]).toLowerCase()] = String(pair[1]);
          }
        });
        return output;
      }
      if (typeof headers === "object") {
        Object.entries(headers).forEach(([key, value]) => {
          output[String(key).toLowerCase()] = String(value);
        });
        return output;
      }
      String(headers)
        .trim()
        .split(/\r?\n/)
        .forEach((line) => {
          const index = line.indexOf(":");
          if (index > 0) {
            output[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
          }
        });
    } catch (_) {
      return output;
    }
    return output;
  };

  const isReusableRequestHeader = (name) => {
    const normalized = String(name || "").toLowerCase();
    return REUSABLE_REQUEST_HEADER_NAMES.has(normalized) || /csrf|xsrf/.test(normalized);
  };

  const reusableRequestHeaders = (headers) => {
    const output = {};
    Object.entries(headersToObject(headers)).forEach(([key, value]) => {
      if (value && isReusableRequestHeader(key)) {
        output[key] = String(value);
      }
    });
    return output;
  };

  const redactRequestHeadersForExport = (headers) => {
    const output = {};
    Object.entries(headersToObject(headers)).forEach(([key, value]) => {
      output[key] = SENSITIVE_REQUEST_HEADER_PATTERN.test(key) ? "[redacted]" : String(value);
    });
    return output;
  };

  const fetchRequestHeaders = (input, init) => ({
    ...headersToObject(input && typeof input === "object" ? input.headers : undefined),
    ...headersToObject(init && init.headers)
  });

  const bodyToText = (body) => {
    if (body == null) {
      return "";
    }
    if (typeof body === "string") {
      return body;
    }
    if (body instanceof URLSearchParams) {
      return body.toString();
    }
    if (body instanceof FormData) {
      const fields = [];
      body.forEach((value, key) => {
        fields.push([key, value instanceof File ? `[File ${value.name}]` : String(value)]);
      });
      return JSON.stringify(fields);
    }
    if (body instanceof Blob) {
      return `[Blob ${body.type || "unknown"} ${body.size} bytes]`;
    }
    if (body instanceof ArrayBuffer) {
      return `[ArrayBuffer ${body.byteLength} bytes]`;
    }
    return Object.prototype.toString.call(body);
  };

  const safeJsonParse = (text) => {
    try {
      return JSON.parse(text);
    } catch (_) {
      return undefined;
    }
  };

  const isKnownRuntimeEndpoint = (absoluteUrl) => {
    let path = absoluteUrl;
    try {
      path = new URL(absoluteUrl).pathname;
    } catch (_) {
      // Keep the original string.
    }
    return (
      /\/anyclaw\/agent\/api\/v\d+\/agents\/[^/]+\/agent_runs(?:\/|$)/i.test(path) ||
      /\/agent_runs(?:\/|$)/i.test(path) ||
      /\/runtime[-_]?logs?(?:\/|$)/i.test(path) ||
      /\/trace_tree(?:\/|$)/i.test(path) ||
      /\/spans\/[^/?#]+/i.test(path)
    );
  };

  const countPayloadSignals = (text) => {
    const haystack = String(text || "").toLowerCase();
    const signals = [
      "conversationid",
      "conversation_id",
      "tool",
      "llm",
      "mcp",
      "input",
      "output",
      "span",
      "trace",
      "status",
      "agent",
      "runtime",
      "log"
    ];
    return signals.reduce((count, signal) => count + (haystack.includes(signal) ? 1 : 0), 0);
  };

  const classifyCapture = (rawUrl, text) => {
    const absoluteUrl = normalizedUrl(rawUrl);
    const url = new URL(absoluteUrl, location.href);
    if (url.hostname !== location.hostname) {
      return null;
    }

    const { runId, spanId } = getCurrentPageSignals();
    const haystack = `${absoluteUrl}\n${text}`.toLowerCase();
    const reasons = [];

    if (runId && haystack.includes(runId.toLowerCase())) {
      reasons.push("contains_run_id");
    }
    if (spanId && haystack.includes(spanId.toLowerCase())) {
      reasons.push("contains_span_id");
    }
    if (isKnownRuntimeEndpoint(absoluteUrl)) {
      reasons.push("known_runtime_log_endpoint");
    }

    const urlHasLogSignal = /runtime|run[-_]?id|span[-_]?id|trace_tree|trace|logs?|conversation/.test(
      absoluteUrl.toLowerCase()
    );
    const signalCount = countPayloadSignals(haystack);
    if (urlHasLogSignal && signalCount >= 2) {
      reasons.push("url_and_payload_look_log_like");
    }
    if ((reasons.includes("contains_run_id") || reasons.includes("contains_span_id")) && signalCount >= 3) {
      reasons.push("payload_has_many_log_fields");
    }

    return reasons.length ? reasons : null;
  };

  const canReadResponse = (contentType, _contentLength, rawUrl) => {
    if (!contentType) {
      return /agent_runs|runtime[-_]?logs?|trace_tree|trace|run[-_]?id|span[-_]?id|spans\//i.test(
        String(rawUrl || "")
      );
    }
    return /json|text|javascript|x-www-form-urlencoded/i.test(contentType);
  };

  const trimBodyText = (bodyText) => {
    if (bodyText.length <= MAX_BODY_LENGTH) {
      return { bodyText, truncated: false };
    }
    return {
      bodyText: `${bodyText.slice(0, MAX_BODY_LENGTH)}\n...[truncated by exporter]`,
      truncated: true
    };
  };

  const postCapture = (payload) => {
    window.postMessage({ source: SOURCE, payload }, location.origin);
  };

  const emitCapture = ({ source, request, response, startedAt, bodyText, truncated, matchReasons }) => {
    const parsed = /json/i.test(response.headers["content-type"] || "") ? safeJsonParse(bodyText) : undefined;
    const reusableHeaders = reusableRequestHeaders(request.headers);
    postCapture({
      type: "response",
      capturedAt: new Date().toISOString(),
      runtimeRequestHeaders: reusableHeaders,
      source,
      matchReasons,
      request: {
        ...request,
        headers: redactRequestHeadersForExport(request.headers)
      },
      response: {
        ...response,
        bodyText,
        bodyJson: parsed,
        truncated
      },
      durationMs: Date.now() - startedAt,
      url: response.url || request.url,
      method: request.method,
      status: response.status,
      contentType: response.headers["content-type"] || "",
      truncated,
      body: parsed === undefined ? bodyText : parsed
    });
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const startedAt = Date.now();
      const request = {
        url: normalizedUrl(typeof input === "string" ? input : input && input.url),
        method: (init && init.method) || (input && input.method) || "GET",
        body: init && "body" in init ? bodyToText(init.body) : "",
        headers: fetchRequestHeaders(input, init)
      };
      const response = await originalFetch.apply(this, arguments);

      try {
        const clone = response.clone();
        const headers = headersToObject(clone.headers);
        const contentType = headers["content-type"] || "";
        const contentLength = Number(headers["content-length"] || 0);
        if (canReadResponse(contentType, contentLength, request.url)) {
          const rawText = await clone.text();
          const trimmed = trimBodyText(rawText);
          const matchReasons = classifyCapture(request.url || clone.url, trimmed.bodyText);
          if (matchReasons) {
            emitCapture({
              source: "fetch",
              request,
              response: {
                url: normalizedUrl(clone.url || request.url),
                status: clone.status,
                statusText: clone.statusText,
                headers
              },
              startedAt,
              bodyText: trimmed.bodyText,
              truncated: trimmed.truncated,
              matchReasons
            });
          }
        }
      } catch (_) {
        // Capture must never affect page behavior.
      }

      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__ailyRuntimeLogExporter = {
      method: method || "GET",
      url: normalizedUrl(url),
      headers: {}
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
    try {
      const meta = this.__ailyRuntimeLogExporter;
      if (meta && name) {
        meta.headers[String(name).toLowerCase()] = String(value);
      }
    } catch (_) {
      // Header capture is best-effort.
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const startedAt = Date.now();
    const requestBody = bodyToText(body);
    try {
      this.addEventListener("loadend", function onLoadEnd() {
        try {
          const meta = this.__ailyRuntimeLogExporter || {};
          if (!meta.url) {
            return;
          }

          const headers = headersToObject(this.getAllResponseHeaders());
          const contentType = headers["content-type"] || "";
          const contentLength = Number(headers["content-length"] || 0);
          if (!canReadResponse(contentType, contentLength, meta.url)) {
            return;
          }
          if (this.responseType && this.responseType !== "text" && this.responseType !== "json") {
            return;
          }

          const responseText =
            this.responseType === "json"
              ? JSON.stringify(this.response)
              : typeof this.responseText === "string"
                ? this.responseText
                : typeof this.response === "string"
                  ? this.response
                  : "";
          const trimmed = trimBodyText(responseText);
          const responseUrl = normalizedUrl(this.responseURL || meta.url);
          const matchReasons = classifyCapture(meta.url || responseUrl, trimmed.bodyText);
          if (!matchReasons) {
            return;
          }

          emitCapture({
            source: "xhr",
            request: {
              url: meta.url,
              method: meta.method,
              body: requestBody,
              headers: meta.headers || {}
            },
            response: {
              url: responseUrl,
              status: this.status,
              statusText: this.statusText,
              headers
            },
            startedAt,
            bodyText: trimmed.bodyText,
            truncated: trimmed.truncated,
            matchReasons
          });
        } catch (_) {
          // Capture must never affect page behavior.
        }
      });
    } catch (_) {
      // Ignore pages that prevent XHR listener registration.
    }
    return originalSend.apply(this, arguments);
  };
})();
