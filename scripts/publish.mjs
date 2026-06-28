#!/usr/bin/env node
/**
 * Publish the bundled `wolli` package (mirrors pi's scripts/publish.mjs, single-package).
 *
 * Expects apps/cli/bundle to exist (run `pnpm --filter wolli build:bundle` first).
 * Skips if that version is already on npm. Publishes with provenance; in CI this
 * uses OIDC trusted publishing (no NPM_TOKEN).
 *
 * Usage: node scripts/publish.mjs [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(repoRoot, "apps/cli/bundle");
const dryRun = process.argv.includes("--dry-run");

function npm(args, opts = {}) {
	const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
	console.log(`$ npm ${args.join(" ")}`);
	const result = spawnSync(cmd, args, { cwd: bundleDir, encoding: "utf8", stdio: opts.capture ? ["inherit", "pipe", "pipe"] : "inherit" });
	return result;
}

if (!existsSync(join(bundleDir, "dist/cli.js")) || !existsSync(join(bundleDir, "package.json"))) {
	console.error("apps/cli/bundle is missing. Run: pnpm --filter wolli build:bundle");
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(bundleDir, "package.json"), "utf8"));

function isPublished(name, version) {
	const result = npm(["view", `${name}@${version}`, "version", "--json"], { capture: true });
	if (result.status === 0 && (result.stdout || "").trim()) return true;
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) return false;
	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

if (isPublished(pkg.name, pkg.version)) {
	console.log(`${pkg.name}@${pkg.version} is already published; nothing to do.`);
	process.exit(0);
}

if (dryRun) {
	const result = npm(["publish", "--dry-run", "--access", "public", "--ignore-scripts"]);
	process.exit(result.status ?? 0);
}

const result = npm(["publish", "--access", "public", "--provenance", "--ignore-scripts"]);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`\nPublished ${pkg.name}@${pkg.version}.`);
