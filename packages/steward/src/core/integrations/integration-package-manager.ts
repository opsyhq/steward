/**
 * Integration package manager.
 *
 * A trimmed parallel of coding-agent's `DefaultPackageManager`: the install
 * helpers are kept as methods (with `this.settingsManager` / `this.agentDir`
 * preserved) so they stay diffable against the source. It installs a
 * self-contained integration package — one that brings its OWN `node_modules`
 * (e.g. grammy) — and makes discovery find it via a symlink at
 * `<agentDir>/integrations/<name>` → the installed package dir.
 *
 *  - npm:   install into `<agentDir>/npm`, package lands at
 *           `<agentDir>/npm/node_modules/<name>`.
 *  - git:   clone into `<agentDir>/npm/git/<name>` and install its deps.
 *  - local: the resolved source dir (author keeps their own `node_modules`).
 *
 * The class holds no mutable state — just `agentDir` + `settingsManager`.
 */

import type { ChildProcess } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnProcess } from "../../utils/child-process.ts";
import { type GitSource, parseGitUrl } from "../../utils/git.ts";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";
import { isStdoutTakenOver } from "../output-guard.ts";
import type { SettingsManager } from "../settings-manager.ts";

function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	pinned: boolean;
};

type LocalSource = {
	type: "local";
	path: string;
};

export type ParsedSource = NpmSource | GitSource | LocalSource;

/** One installed integration package, as surfaced by `list()`. */
export interface InstalledIntegration {
	/** The discovery name (the symlink's basename under `<agentDir>/integrations/`). */
	name: string;
	/** The package's own `name` (npm identity) when known, else the backing dir. */
	source: string;
	/** The real backing package dir the symlink resolves to. */
	dir: string;
}

export interface IntegrationPackageManagerOptions {
	/** The per-agent home dir, e.g. `~/.steward/agents/<name>`. */
	agentDir: string;
	settingsManager: SettingsManager;
}

export interface IntegrationPackageManager {
	parseSource(spec: string): ParsedSource;
	install(spec: string): Promise<{ name: string; dir: string }>;
	remove(spec: string): Promise<boolean>;
	list(): InstalledIntegration[];
}

export class DefaultIntegrationPackageManager implements IntegrationPackageManager {
	private agentDir: string;
	private settingsManager: SettingsManager;

	constructor(options: IntegrationPackageManagerOptions) {
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	parseSource(source: string): ParsedSource {
		if (source.startsWith("npm:")) {
			const spec = source.slice("npm:".length).trim();
			const { name, version } = this.parseNpmSpec(spec);
			return {
				type: "npm",
				spec,
				name,
				pinned: Boolean(version),
			};
		}

		if (isLocalPath(source)) {
			return { type: "local", path: source };
		}

		// Try parsing as git URL
		const gitParsed = parseGitUrl(source);
		if (gitParsed) {
			return gitParsed;
		}

		return { type: "local", path: source };
	}

	async install(spec: string): Promise<{ name: string; dir: string }> {
		const parsed = this.parseSource(spec);
		const name = this.sourceName(parsed);

		let backingDir: string;
		switch (parsed.type) {
			case "npm":
				await this.installNpm(parsed);
				backingDir = this.getManagedNpmInstallPath(parsed);
				break;
			case "git":
				backingDir = await this.installGit(parsed, name);
				break;
			case "local": {
				backingDir = resolvePath(parsed.path);
				if (!existsSync(backingDir)) {
					throw new Error(`Local path not found: ${backingDir}`);
				}
				break;
			}
		}

		if (!existsSync(backingDir)) {
			throw new Error(`Install did not produce a package directory: ${backingDir}`);
		}

		this.linkIntegration(name, backingDir);
		return { name, dir: backingDir };
	}

	/**
	 * Symlink-safe removal. First unlinks the discovery symlink at
	 * `<agentDir>/integrations/<name>` (never `rmSync(recursive)` through it — that would
	 * delete a local install's source), then reclaims the real backing dir for managed
	 * sources via the reference's dispatch-on-`parsed.type` shape (npm → `uninstallNpm`,
	 * git → `removeGit`, local → keep its source). Returns whether the integration was
	 * linked (drives the CLI's "no matching integration" message).
	 */
	async remove(spec: string): Promise<boolean> {
		const parsed = this.parseSource(spec);
		const name = this.sourceName(parsed);
		const unlinked = this.unlinkIntegration(name);

		switch (parsed.type) {
			case "npm":
				await this.uninstallNpm(parsed);
				break;
			case "git":
				this.removeGit(name);
				break;
			case "local":
				break;
		}

		return unlinked;
	}

	list(): InstalledIntegration[] {
		const dir = this.getIntegrationsDir();
		if (!existsSync(dir)) {
			return [];
		}
		const installed: InstalledIntegration[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isSymbolicLink() && !entry.isDirectory()) {
				continue;
			}
			const linkPath = join(dir, entry.name);
			let realDir: string;
			try {
				realDir = realpathSync(linkPath);
			} catch {
				continue; // broken symlink
			}
			let source = realDir;
			const pkgPath = join(realDir, "package.json");
			if (existsSync(pkgPath)) {
				// The package's own `name` is the friendlier source label when present.
				try {
					const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
					if (pkg.name) source = pkg.name;
				} catch {
					// keep realDir as the source label
				}
			}
			installed.push({ name: entry.name, source, dir: realDir });
		}
		return installed;
	}

	/** Deterministic discovery name from a parsed source (drives the symlink basename). */
	private sourceName(parsed: ParsedSource): string {
		if (parsed.type === "npm") return basename(parsed.name);
		if (parsed.type === "git") return basename(parsed.path);
		return basename(resolvePath(parsed.path));
	}

	/** `<agentDir>/integrations` — where installed packages are symlinked for discovery. */
	private getIntegrationsDir(): string {
		return join(this.agentDir, "integrations");
	}

	private getNpmInstallRoot(): string {
		return join(this.agentDir, "npm");
	}

	private getGitInstallRoot(): string {
		return join(this.agentDir, "npm", "git");
	}

	private getManagedNpmInstallPath(source: NpmSource): string {
		return join(this.agentDir, "npm", "node_modules", source.name);
	}

	private linkIntegration(name: string, backingDir: string): void {
		const integrationsDir = this.getIntegrationsDir();
		if (!existsSync(integrationsDir)) {
			mkdirSync(integrationsDir, { recursive: true });
		}
		// Replace any existing symlink/entry (reinstall) before re-linking.
		this.unlinkIntegration(name);
		const linkPath = join(integrationsDir, name);
		const type = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(backingDir, linkPath, type);
	}

	/**
	 * Remove the discovery symlink at `<agentDir>/integrations/<name>`. Uses `lstat` (not
	 * `stat`) so the symlink itself is removed and never followed; a real directory here
	 * is unexpected but removed in place. Returns whether anything was there.
	 */
	private unlinkIntegration(name: string): boolean {
		const linkPath = join(this.getIntegrationsDir(), name);
		try {
			const st = lstatSync(linkPath);
			if (st.isSymbolicLink() || st.isFile()) {
				unlinkSync(linkPath);
			} else {
				rmSync(linkPath, { recursive: true, force: true });
			}
			return true;
		} catch {
			return false;
		}
	}

	/** Reclaim a git source's clone dir. Mirrors `DefaultPackageManager.removeGit`. */
	private removeGit(name: string): void {
		const targetDir = join(this.getGitInstallRoot(), name);
		if (!existsSync(targetDir)) return;
		rmSync(targetDir, { recursive: true, force: true });
	}

	private parseNpmSpec(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) {
			return { name: spec };
		}
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}

	private getNpmCommand(): { command: string; args: string[] } {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	private getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const commandParts = [npmCommand.command, ...npmCommand.args];
		const separatorIndex = commandParts.lastIndexOf("--");
		const packageManagerCommand = separatorIndex >= 0 ? commandParts[separatorIndex + 1] : npmCommand.command;
		return packageManagerCommand ? basename(packageManagerCommand).replace(/\.(cmd|exe)$/i, "") : "";
	}

	private async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		const npmCommand = this.getNpmCommand();
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	private getGitDependencyInstallArgs(): string[] {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (configuredCommand && configuredCommand.length > 0) {
			return ["install"];
		}
		return ["install", "--omit=dev"];
	}

	private getNpmInstallArgs(specs: string[], installRoot: string): string[] {
		const packageManagerName = this.getPackageManagerName();
		// Integration packages run inside steward and resolve host APIs through loader
		// aliases/virtual modules. Disable peer dependency resolution for managed installs
		// (npm's --legacy-peer-deps, and equivalent bun/pnpm settings) so package managers
		// do not install or solve host-provided peers.
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		}
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
	}

	private async installNpm(source: NpmSource): Promise<void> {
		const installRoot = this.getNpmInstallRoot();
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	private async uninstallNpm(source: NpmSource): Promise<void> {
		const installRoot = this.getNpmInstallRoot();
		if (!existsSync(installRoot)) {
			return;
		}
		if (this.getPackageManagerName() === "bun") {
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		await this.runNpmCommand(["uninstall", source.name, "--prefix", installRoot]);
	}

	/**
	 * Clone a git source into `<agentDir>/npm/git/<name>` and install its deps.
	 * Trimmed from `DefaultPackageManager.installGit` (no update path in v1): a
	 * pre-existing dir is removed so the clone is always fresh.
	 */
	private async installGit(source: GitSource, name: string): Promise<string> {
		const targetDir = join(this.getGitInstallRoot(), name);
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		const gitRoot = this.getGitInstallRoot();
		this.ensureGitIgnore(gitRoot);
		mkdirSync(dirname(targetDir), { recursive: true });

		await this.runCommand("git", ["clone", source.repo, targetDir]);
		if (source.ref) {
			await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
		return targetDir;
	}

	private ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		this.ensureGitIgnore(installRoot);
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			const pkgJson = { name: "steward-integrations", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	private ensureGitIgnore(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}
}
