const { spawn } = require("child_process");
const { readFile } = require("fs/promises");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

// config file → { devCommand, devPort } 매핑
// devCommand가 null이면 해당 config 파일 존재만으로 프론트엔드 확정, scripts에서 command 탐색
const FRAMEWORK_SIGNATURES = [
  { config: "vite.config.ts",       devCommand: "npx vite",                devPort: 5173 },
  { config: "vite.config.js",       devCommand: "npx vite",                devPort: 5173 },
  { config: "vite.config.mts",      devCommand: "npx vite",                devPort: 5173 },
  { config: "next.config.js",       devCommand: "npx next dev",            devPort: 3000 },
  { config: "next.config.mjs",      devCommand: "npx next dev",            devPort: 3000 },
  { config: "next.config.ts",       devCommand: "npx next dev",            devPort: 3000 },
  { config: "nuxt.config.ts",       devCommand: "npx nuxi dev",            devPort: 3000 },
  { config: "nuxt.config.js",       devCommand: "npx nuxi dev",            devPort: 3000 },
  { config: "svelte.config.js",     devCommand: "npx vite dev",            devPort: 5173 },
  { config: "angular.json",         devCommand: "npx ng serve",            devPort: 4200 },
  { config: "astro.config.mjs",     devCommand: "npx astro dev",           devPort: 4321 },
  { config: "astro.config.ts",      devCommand: "npx astro dev",           devPort: 4321 },
  { config: "remix.config.js",      devCommand: "npx remix dev",           devPort: 3000 },
  { config: "gatsby-config.js",     devCommand: "npx gatsby develop",      devPort: 8000 },
  { config: "gatsby-config.ts",     devCommand: "npx gatsby develop",      devPort: 8000 },
  { config: "webpack.config.js",    devCommand: null,                      devPort: 8080 },
  { config: "webpack.config.ts",    devCommand: null,                      devPort: 8080 },
];

// dependency 이름 → 프론트엔드 확정 (config 파일이 없을 때 fallback)
const FRONTEND_DEPS = new Set([
  "react", "react-dom", "vue", "svelte", "@sveltejs/kit",
  "next", "nuxt", "@angular/core", "astro", "solid-js",
  "preact", "lit", "gatsby", "remix", "@remix-run/react",
  "ember-source", "alpinejs",
]);

// Python 프레임워크 감지
const PYTHON_SIGNATURES = [
  { config: "manage.py",          devCommand: "python manage.py runserver", devPort: 8000 },
  { config: "app.py",             devCommand: null,                         devPort: 5000 },
  { config: "streamlit_app.py",   devCommand: "streamlit run streamlit_app.py", devPort: 8501 },
];

// Ruby/Go/Rust 등
const OTHER_SIGNATURES = [
  { config: "Gemfile",   marker: "rails",  devCommand: "bundle exec rails server", devPort: 3000 },
  { config: "Procfile",  marker: null,      devCommand: null,                        devPort: 5000 },
];

function resolvePort(taskId) {
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = ((hash << 5) - hash + taskId.charCodeAt(i)) | 0;
  }
  return 9222 + (Math.abs(hash) % 1000);
}

function findChrome() {
  for (const p of CHROME_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function pollHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${url}`));
      const req = http.get(url, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve(body));
      });
      req.on("error", () => setTimeout(attempt, 500));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

async function launchBrowser(taskId) {
  const chromePath = findChrome();
  if (!chromePath) return null;

  const port = resolvePort(taskId);
  const profileDir = path.join(os.tmpdir(), `ucm-chrome-${taskId}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const child = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--window-size=1440,900",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();

  try {
    await pollHttp(`http://localhost:${port}/json/version`, 15000);
  } catch {
    killBrowser({ process: child, profileDir });
    return null;
  }

  return { process: child, port, profileDir, kill: () => killBrowser({ process: child, profileDir }) };
}

function killBrowser(browser) {
  if (!browser) return;
  try {
    process.kill(browser.process.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try { process.kill(browser.process.pid, "SIGKILL"); } catch {}
  }, 1500);
  try { fs.rmSync(browser.profileDir, { recursive: true, force: true }); } catch {}
}

// port 번호를 script 내용에서 추출 (--port 3001, -p 8080, :4200 등)
function extractPortFromScript(script) {
  const match = script.match(/(?:--port|--listen|-p)\s+(\d{2,5})/i)
    || script.match(/:(\d{4,5})\b/);
  if (match) {
    const port = parseInt(match[1], 10);
    if (port > 0 && port < 65536) return port;
  }
  return null;
}

// package.json scripts에서 dev server를 찾는 우선순위
const SCRIPT_PRIORITY = ["dev", "serve", "start:dev", "start"];

function pickDevScript(scripts) {
  if (!scripts) return null;
  for (const name of SCRIPT_PRIORITY) {
    if (scripts[name]) return { name, value: scripts[name] };
  }
  // "dev:" prefix (dev:server, dev:web 등)
  for (const [name, value] of Object.entries(scripts)) {
    if (name.startsWith("dev:")) return { name, value };
  }
  return null;
}

// scripts 내용에서 웹서버 관련 키워드가 있는지 확인
function scriptLooksLikeWebServer(scriptValue) {
  const webPatterns = /\b(vite|next|nuxt|webpack|react-scripts|ng serve|astro|remix|gatsby|http-server|serve|live-server|browser-sync|parcel|turbopack|rsbuild)\b/i;
  return webPatterns.test(scriptValue);
}

async function detectFrontend(projectPath) {
  // ── 1. 명시적 설정: .ucm.json (최우선) ──
  try {
    const config = JSON.parse(await readFile(path.join(projectPath, ".ucm.json"), "utf-8"));
    if (config.devCommand) {
      return {
        devCommand: config.devCommand,
        devPort: config.devPort || 3000,
        source: ".ucm.json",
      };
    }
  } catch {}

  // ── 2. 명시적 설정: package.json "ucm" 필드 ──
  let pkg = null;
  try {
    pkg = JSON.parse(await readFile(path.join(projectPath, "package.json"), "utf-8"));
    if (pkg.ucm?.devCommand) {
      return {
        devCommand: pkg.ucm.devCommand,
        devPort: pkg.ucm.devPort || 3000,
        source: "package.json/ucm",
      };
    }
  } catch {}

  // ── 3. 프레임워크 config 파일 감지 ──
  for (const sig of FRAMEWORK_SIGNATURES) {
    if (fileExists(path.join(projectPath, sig.config))) {
      const devScript = pkg ? pickDevScript(pkg.scripts) : null;
      const devCommand = devScript
        ? `npm run ${devScript.name}`
        : sig.devCommand;
      const scriptPort = devScript ? extractPortFromScript(devScript.value) : null;
      return {
        devCommand,
        devPort: scriptPort || sig.devPort,
        source: `framework:${sig.config}`,
      };
    }
  }

  // ── 4. package.json dependency 기반 감지 ──
  if (pkg) {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasFrontendDep = Object.keys(allDeps).some((d) => FRONTEND_DEPS.has(d));
    if (hasFrontendDep) {
      const devScript = pickDevScript(pkg.scripts);
      if (devScript) {
        const scriptPort = extractPortFromScript(devScript.value);
        return {
          devCommand: `npm run ${devScript.name}`,
          devPort: scriptPort || 3000,
          source: "package.json/deps",
        };
      }
    }
  }

  // ── 5. package.json scripts 내용 분석 (프레임워크 키워드) ──
  if (pkg?.scripts) {
    const devScript = pickDevScript(pkg.scripts);
    if (devScript && scriptLooksLikeWebServer(devScript.value)) {
      const scriptPort = extractPortFromScript(devScript.value);
      return {
        devCommand: `npm run ${devScript.name}`,
        devPort: scriptPort || 3000,
        source: "package.json/scripts",
      };
    }
  }

  // ── 6. Python 프로젝트 ──
  for (const sig of PYTHON_SIGNATURES) {
    if (fileExists(path.join(projectPath, sig.config))) {
      let devCommand = sig.devCommand;
      // app.py: Flask/FastAPI 자동 감지
      if (sig.config === "app.py" && !devCommand) {
        try {
          const content = await readFile(path.join(projectPath, "app.py"), "utf-8");
          if (content.includes("FastAPI")) {
            devCommand = "uvicorn app:app --reload";
            sig.devPort = 8000;
          } else if (content.includes("Flask")) {
            devCommand = "flask run";
          }
        } catch {}
      }
      if (devCommand) {
        return { devCommand, devPort: sig.devPort, source: `python:${sig.config}` };
      }
    }
  }

  // ── 7. Ruby (Gemfile에 rails 포함) ──
  for (const sig of OTHER_SIGNATURES) {
    if (fileExists(path.join(projectPath, sig.config))) {
      if (sig.marker) {
        try {
          const content = await readFile(path.join(projectPath, sig.config), "utf-8");
          if (!content.includes(sig.marker)) continue;
        } catch { continue; }
      }
      if (sig.devCommand) {
        return { devCommand: sig.devCommand, devPort: sig.devPort, source: `other:${sig.config}` };
      }
    }
  }

  // ── 8. Static HTML (public/index.html 또는 root index.html) ──
  const staticPaths = ["index.html", "public/index.html", "dist/index.html"];
  for (const rel of staticPaths) {
    if (fileExists(path.join(projectPath, rel))) {
      const serveDir = path.dirname(path.join(projectPath, rel));
      return {
        devCommand: `npx serve ${serveDir === projectPath ? "." : path.relative(projectPath, serveDir)}`,
        devPort: 3000,
        source: `static:${rel}`,
        staticOnly: true,
      };
    }
  }

  return null;
}

async function startDevServer(projectPath, config) {
  if (!config || !config.devCommand) return null;

  const devPort = config.devPort || 3000;
  const [cmd, ...args] = config.devCommand.split(" ");
  const child = spawn(cmd, args, {
    cwd: projectPath,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(devPort), BROWSER: "none" },
    detached: true,
  });
  child.unref();

  try {
    await pollHttp(`http://localhost:${devPort}`, 30000);
  } catch {
    // server may still work even if poll fails
  }

  return {
    process: child,
    port: devPort,
    url: `http://localhost:${devPort}`,
    kill() {
      try { process.kill(-child.pid, "SIGTERM"); } catch {
        try { child.kill("SIGTERM"); } catch {}
      }
    },
  };
}

module.exports = {
  launchBrowser, killBrowser, detectFrontend, startDevServer,
  resolvePort, findChrome, pollHttp,
  // 테스트용 export
  extractPortFromScript, pickDevScript, scriptLooksLikeWebServer,
  FRAMEWORK_SIGNATURES, FRONTEND_DEPS,
};
