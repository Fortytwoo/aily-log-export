import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const chromePath =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = Number(process.env.CHROME_REMOTE_DEBUGGING_PORT || 9224);
const profileDir = await mkdtemp(path.join(tmpdir(), "aily-log-export-chrome-"));

if (typeof WebSocket === "undefined") {
  throw new Error("This smoke test requires a Node.js runtime with WebSocket support.");
}

const fixtureHtml = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Aily fixture</title></head>
  <body>
    <main>
      <h1>运行日志</h1>
      <section>
        <button aria-label="运行总览">运行总览</button><span>3.65 min</span>
        <button aria-label="LLM 思考">LLM 思考</button><span>13.53 s</span>
        <button aria-label="bash">bash</button><span>666 ms</span>
      </section>
      <section>
        <h2>Input</h2>
        <pre>{"message":"sample input"}</pre>
        <h2>Output</h2>
        <pre>{"message":"sample output"}</pre>
      </section>
    </main>
  </body>
</html>`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeProfileDir(profilePath) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(profilePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      return;
    } catch (error) {
      if (attempt === 7) {
        console.warn(`Profile cleanup skipped: ${error.message}`);
        return;
      }
      await delay(500);
    }
  }
}

async function waitForJson(url, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Chrome is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
    }
  };

  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });

  return {
    opened,
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      ws.close();
    }
  };
}

let chrome;
let cdp;

try {
  chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      `--disable-extensions-except=${root}`,
      `--load-extension=${root}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "about:blank"
    ],
    {
      detached: false,
      stdio: "ignore",
      windowsHide: true
    }
  );

  chrome.on("error", (error) => {
    throw error;
  });

  const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((target) => target.type === "page");
  if (!page) {
    throw new Error("No Chrome page target found");
  }

  cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml)}`;
  await cdp.send("Page.navigate", { url: dataUrl });
  await delay(1000);

  const contentCode = await readFile(path.join(root, "src", "content.js"), "utf8");
  const patchedContentCode = contentCode.replace(
    /return location\.hostname === "feishu\.feishu\.cn" && \/\\\/builder\\\/runtime-log\\\/\?\$\/\.test\(location\.pathname\);/,
    "return true;"
  );

  await cdp.send("Runtime.evaluate", {
    expression: patchedContentCode,
    awaitPromise: false
  });
  await delay(1200);

  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => ({
      toolbar: Boolean(document.getElementById("aily-runtime-log-exporter")),
      checkboxes: document.querySelectorAll(".aily-log-export-checkbox").length,
      state: window.__ailyRuntimeLogExporter.getState()
    }))()`,
    returnByValue: true
  });

  const value = result.result.value;
  if (!value.toolbar || value.checkboxes < 3 || !value.state || value.state.traces < 3) {
    throw new Error(`Unexpected smoke result: ${JSON.stringify(value)}`);
  }

  console.log(`Chrome smoke test passed: ${JSON.stringify(value)}`);
} finally {
  if (cdp) {
    try {
      await cdp.send("Browser.close");
      cdp.close();
    } catch {
      cdp.close();
    }
  }
  if (chrome && !chrome.killed) {
    chrome.kill();
  }
  await delay(1000);
  await removeProfileDir(profileDir);
}
