const fs = require("fs");
const os = require("os");
const path = require("path");

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "hivemind", "zettel");

// IMPORTANT: setupTestDir()는 require("./lib/hivemind/...") 전에 호출해야 한다.
// store.js가 최초 로드 시 process.env.HIVEMIND_DIR을 읽어 경로를 확정하므로,
// 그 전에 환경변수가 설정되어 있어야 테스트 디렉토리를 사용한다.
function setupTestDir() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-test-"));
  process.env.HIVEMIND_DIR = testDir;

  const zettelDir = path.join(testDir, "zettel");
  const indexDir = path.join(testDir, "index");
  const archiveDir = path.join(testDir, "archive");
  const sourcesDir = path.join(testDir, "sources");
  const daemonDir = path.join(testDir, "daemon");
  const adaptersDir = path.join(testDir, "adapters");

  for (const dir of [zettelDir, indexDir, archiveDir, sourcesDir, daemonDir, adaptersDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Copy fixture zettel files
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    fs.copyFileSync(path.join(FIXTURE_DIR, file), path.join(zettelDir, file));
  }

  // Write config
  const config = {
    adapters: { claude: { enabled: true }, codex: { enabled: true }, document: { enabled: true, dirs: [] } },
    decayDays: 30,
    decayWeight: 0.2,
    gcThreshold: 0.05,
    minKeep: 50,
  };
  fs.writeFileSync(path.join(testDir, "config.json"), JSON.stringify(config, null, 2) + "\n");

  return testDir;
}

function cleanupTestDir(testDir) {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.HIVEMIND_DIR;
}

module.exports = { setupTestDir, cleanupTestDir };
