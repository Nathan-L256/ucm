#!/usr/bin/env node
const { copyFileSync, mkdirSync, existsSync } = require("fs");
const path = require("path");
const os = require("os");

const source = path.join(__dirname, "..", "skill", "recall.md");
const targetDir = path.join(os.homedir(), ".claude", "commands");
const target = path.join(targetDir, "recall.md");

const force = process.argv.includes("--force");

if (existsSync(target) && !force) {
  console.log(`이미 존재: ${target}`);
  console.log("덮어쓰려면: npm run install-skill -- --force");
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`설치 완료: ${target}`);
