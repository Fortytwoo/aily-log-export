import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "manifest.json",
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

for (const file of requiredFiles) {
  try {
    await access(path.join(root, file));
  } catch {
    errors.push(`missing file: ${file}`);
  }
}

let manifest;
try {
  manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
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
  if (!manifest.web_accessible_resources?.length) {
    errors.push("page hook must be web-accessible");
  }
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
