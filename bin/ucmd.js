#!/usr/bin/env node
const { main } = require("../lib/ucmd.js");
main().catch((e) => { console.error(e.message); process.exit(1); });
