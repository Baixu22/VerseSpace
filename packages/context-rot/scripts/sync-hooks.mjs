#!/usr/bin/env node
/**
 * 同步 hooks/footprint.mjs → plugin/scripts/footprint.mjs，
 * 保证 Claude Code 插件形态自带最新脚本（单一来源，避免两份漂移）。
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = resolve(HERE, "../hooks/footprint.mjs");
const dst = resolve(HERE, "../plugin/scripts/footprint.mjs");

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log("synced hooks/footprint.mjs → plugin/scripts/footprint.mjs");
