import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "manifest.json",
  "src/background.js",
  "src/content.js",
  "src/content.css",
  "src/page-hook.js",
  "src/popup.html",
  "src/popup.js",
  "src/popup.css",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png"
];

const errors = [];
const readUtf8 = (file) => readFile(path.join(root, file), "utf8");

for (const file of requiredFiles) {
  try {
    await access(path.join(root, file));
  } catch {
    errors.push(`missing file: ${file}`);
  }
}

let manifest;
try {
  manifest = JSON.parse(await readUtf8("manifest.json"));
} catch (error) {
  errors.push(`manifest is not valid JSON: ${error.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) {
    errors.push("manifest_version must be 3");
  }
  const matches = manifest.content_scripts?.[0]?.matches || [];
  if (!matches.includes("https://*.feishu.cn/ai/*")) {
    errors.push("content script must match Feishu Aily pages");
  }
  const hostPermissions = manifest.host_permissions || [];
  if (!hostPermissions.includes("https://*.feishu.cn/*")) {
    errors.push("host permissions must cover Feishu subdomains");
  }
  const permissions = manifest.permissions || [];
  if (!permissions.includes("downloads")) {
    errors.push("downloads permission is required for opening exported ZIP location");
  }
  if (manifest.background?.service_worker !== "src/background.js") {
    errors.push("background service worker must be src/background.js");
  }
  if (!manifest.web_accessible_resources?.length) {
    errors.push("page hook must be web-accessible");
  }
}

let popupJs = "";
try {
  popupJs = await readUtf8("src/popup.js");
} catch {
  // Already reported by the required file check.
}

if (popupJs && !popupJs.includes('exportButton.disabled = result.mode === "run-list" && result.selected === 0;')) {
  errors.push("popup export button must remain enabled on detail pages with zero selected spans");
}

let pageHookJs = "";
try {
  pageHookJs = await readUtf8("src/page-hook.js");
} catch {
  // Already reported by the required file check.
}

if (pageHookJs && /contentLength\s*&&\s*Number\(contentLength\)\s*>\s*MAX_BODY_LENGTH/.test(pageHookJs)) {
  errors.push("page hook must truncate oversized runtime responses instead of skipping by content-length");
}

if (pageHookJs && !pageHookJs.includes("const reusableRequestHeaders =")) {
  errors.push("page hook must capture reusable runtime request headers for CSRF-protected active prefetch");
}

if (pageHookJs && !pageHookJs.includes("redactRequestHeadersForExport")) {
  errors.push("page hook must redact reusable request header values before exporting raw responses");
}

let contentJs = "";
try {
  contentJs = await readUtf8("src/content.js");
} catch {
  // Already reported by the required file check.
}

if (contentJs && !contentJs.includes("async function prefetchSpanDetailsFromTraceTree")) {
  errors.push("deep export must prefetch span details from trace_tree before DOM fallback");
}

if (contentJs && !contentJs.includes("state.runtimeRequestHeaders")) {
  errors.push("content script must retain reusable runtime request headers outside exported raw responses");
}

if (contentJs && !contentJs.includes("headers: buildRuntimeFetchHeaders(url)")) {
  errors.push("active runtime fetch must reuse captured CSRF headers");
}

if (contentJs && !contentJs.includes("const { runtimeRequestHeaders, ...capturedPayload } = payload;")) {
  errors.push("content script must strip reusable request headers before storing raw responses");
}

if (
  contentJs &&
  !(
    contentJs.indexOf("await prefetchSpanDetailsFromTraceTree") >= 0 &&
    contentJs.indexOf("await prefetchSpanDetailsFromTraceTree") < contentJs.indexOf("await resetToRootNode()")
  )
) {
  errors.push("deep export path must call prefetchSpanDetailsFromTraceTree before clicking DOM nodes");
}

for (const size of [16, 32, 48, 128]) {
  const iconPath = path.join(root, "icons", `icon${size}.png`);
  try {
    const info = await stat(iconPath);
    if (info.size <= 0) {
      errors.push(`empty icon: icon${size}.png`);
    }
  } catch {
    // Already reported by the required file check.
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Extension validation passed");
