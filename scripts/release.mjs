#!/usr/bin/env node
/**
 * Release the `wolli` bundle (mirrors pi's scripts/release.mjs, single-package).
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Steps: clean-tree check -> bump apps/cli/package.json version -> run checks ->
 * commit + tag vX.Y.Z -> push branch + tag. The tag triggers
 * .github/workflows/release.yml, which builds, bundles, and publishes to npm.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(repoRoot, "apps/cli/package.json");

const target = process.argv[2];
const BUMPS = new Set(["major", "minor", "patch"]);
const SEMVER = /^\d+\.\d+\.\d+$/;
if (!target || (!BUMPS.has(target) && !SEMVER.test(target))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd) {
	console.log(`$ ${cmd}`);
	execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
}
function capture(cmd) {
	return execSync(cmd, { cwd: repoRoot, encoding: "utf8" });
}
function parse(v) {
	return v.split(".").map(Number);
}
function bump(version, kind) {
	const [a, b, c] = parse(version);
	if (kind === "major") return `${a + 1}.0.0`;
	if (kind === "minor") return `${a}.${b + 1}.0`;
	return `${a}.${b}.${c + 1}`;
}
function gt(a, b) {
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
	}
	return false;
}

if (capture("git status --porcelain").trim()) {
	console.error("Error: uncommitted changes. Commit or stash first.");
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
const next = BUMPS.has(target) ? bump(current, target) : target;
if (!gt(next, current)) {
	console.error(`Error: ${next} must be greater than current version ${current}.`);
	process.exit(1);
}

console.log(`Releasing wolli ${current} -> ${next}\n`);
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);

run("pnpm typecheck");
run("pnpm lint");

run("git add apps/cli/package.json");
run(`git commit -m "Release v${next}"`);
run(`git tag v${next}`);
run("git push origin HEAD");
run(`git push origin v${next}`);

console.log(`\nPushed v${next}. CI (release.yml) will build, bundle, and publish to npm.`);
