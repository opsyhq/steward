/**
 * Per-agent, per-service runtime state for integrations.
 *
 * Where `integration-account-storage.ts` holds the credential/config records an
 * integration is *configured* with, this store holds the machine-written state an
 * integration *accumulates* at runtime (the scheduler's jobs). The on-disk shape is
 * one flat `Record<string, unknown>` per service, each its own file at
 * `~/.steward/agents/<name>/store/<service>.json`. Keeping high-churn state in a
 * separate per-service file means a per-tick write never rewrites the credentials file.
 *
 * Process-scoped and must survive `/reload`: the producer is torn down + rebuilt on
 * reload, but the store (and the jobs it holds) persists.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";
import { getIntegrationStorePath } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";

/** One service's state file: a flat bag of arbitrary JSON values. */
export type IntegrationStoreData = Record<string, unknown>;

type LockResult<T> = {
	result: T;
	next?: string;
};

const STORE_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface IntegrationStoreBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
}

export class FileIntegrationStoreBackend implements IntegrationStoreBackend {
	private storagePath: string;

	constructor(storagePath: string) {
		this.storagePath = normalizePath(storagePath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.storagePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.storagePath)) {
			writeFileSync(this.storagePath, "{}", STORE_FILE_WRITE_OPTIONS);
			chmodSync(this.storagePath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire integration store lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.storagePath);
			const current = existsSync(this.storagePath) ? readFileSync(this.storagePath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.storagePath, next, STORE_FILE_WRITE_OPTIONS);
				chmodSync(this.storagePath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemoryIntegrationStoreBackend implements IntegrationStoreBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Per-agent integration state store, one JSON file per service. Backends are created
 * lazily on first touch so a service that never stores state never opens a file. Each
 * mutation re-reads + merges against the fresh on-disk copy under lock, so a concurrent
 * writer to a different key in the same file can't be clobbered.
 */
export class IntegrationStore {
	/** service → its backend (created on first touch). */
	private backends: Map<string, IntegrationStoreBackend> = new Map();
	/** service → last-known parsed state. */
	private cache: Map<string, IntegrationStoreData> = new Map();
	/** services whose file failed to parse — left untouched so a bad file isn't clobbered. */
	private loadErrors: Map<string, Error> = new Map();
	private errors: Error[] = [];
	private backendFactory: (service: string) => IntegrationStoreBackend;

	private constructor(backendFactory: (service: string) => IntegrationStoreBackend) {
		this.backendFactory = backendFactory;
	}

	/** Per-agent store at `~/.steward/agents/<name>/store/<service>.json`. */
	static create(agentName: string): IntegrationStore {
		return new IntegrationStore(
			(service) => new FileIntegrationStoreBackend(getIntegrationStorePath(agentName, service)),
		);
	}

	/** In-memory store, one backend per service, seeded from `seed[service]`. */
	static inMemory(seed: Record<string, IntegrationStoreData> = {}): IntegrationStore {
		const store = new IntegrationStore(() => new InMemoryIntegrationStoreBackend());
		for (const [service, data] of Object.entries(seed)) {
			for (const [key, value] of Object.entries(data)) {
				store.set(service, key, value);
			}
		}
		return store;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStoreData(content: string | undefined): IntegrationStoreData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as IntegrationStoreData;
	}

	private ensureBackend(service: string): IntegrationStoreBackend {
		let backend = this.backends.get(service);
		if (!backend) {
			backend = this.backendFactory(service);
			this.backends.set(service, backend);
		}
		return backend;
	}

	/** Parsed state for one service, loaded from its file on first access. */
	private loadService(service: string): IntegrationStoreData {
		const cached = this.cache.get(service);
		if (cached) {
			return cached;
		}
		let data: IntegrationStoreData = {};
		try {
			this.ensureBackend(service).withLock((current) => {
				data = this.parseStoreData(current);
				return { result: undefined };
			});
			this.loadErrors.delete(service);
		} catch (error) {
			this.loadErrors.set(service, error as Error);
			this.recordError(error);
		}
		this.cache.set(service, data);
		return data;
	}

	/** Apply a single-key mutation: optimistic in-memory, then merge against fresh on-disk under lock. */
	private persistMutation(service: string, mutate: (data: IntegrationStoreData) => void): void {
		const optimistic = { ...this.loadService(service) };
		mutate(optimistic);
		this.cache.set(service, optimistic);

		if (this.loadErrors.has(service)) {
			return;
		}
		try {
			this.ensureBackend(service).withLock((current) => {
				const fresh = this.parseStoreData(current);
				mutate(fresh);
				this.cache.set(service, fresh);
				return { result: undefined, next: JSON.stringify(fresh, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/** Read one key from a service's state. */
	get(service: string, key: string): unknown {
		return this.loadService(service)[key];
	}

	/** Write one key into a service's state. */
	set(service: string, key: string, value: unknown): void {
		this.persistMutation(service, (data) => {
			data[key] = value;
		});
	}

	/** A copy of a service's whole state. */
	getAll(service: string): IntegrationStoreData {
		return { ...this.loadService(service) };
	}

	/** Remove one key from a service's state. */
	delete(service: string, key: string): void {
		this.persistMutation(service, (data) => {
			delete data[key];
		});
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}
}
