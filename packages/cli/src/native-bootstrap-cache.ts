/**
 * Local cache of a gateway's native Work bootstrap (`get_info` catalog routes
 * and organization context) plus the native tool name each Work callable
 * resolved to.
 *
 * Every `tedix work` verb is a new process, so without it each verb pays a
 * `get_info` round trip (about 1-1.5 s on Connect) before its catalog checks.
 * The cached bootstrap passes the same checks as a fresh one, and the catalog
 * descriptors expire independently after five minutes. Server authorization
 * and mutation state checks still run on every invocation.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CredentialStoreOpts,
	credentialDirectory,
} from "./credential-store";

/** How long a bootstrap answer is reused. */
export const NATIVE_BOOTSTRAP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const NATIVE_DESCRIPTOR_CACHE_TTL_MS = 5 * 60 * 1000;

interface NativeResolution {
	at: number;
	catalogHash: string;
	row: unknown;
	detail: unknown;
}

export interface NativeBootstrapEntry {
	/** Raw `get_info` fields; re-validated on every read. */
	bootstrap: { nativeContext: unknown; nativeCatalog: unknown };
	/** Native tool name per Work callable, from the last verified resolution. */
	tools: Record<string, string>;
	resolutions?: Record<string, NativeResolution>;
}

export interface NativeBootstrapCache {
	read(key: string): NativeBootstrapEntry | undefined;
	write(key: string, entry: NativeBootstrapEntry): void;
	forget(key: string): void;
}

type Entries = Record<string, NativeBootstrapEntry & { at: number }>;

/** File-backed cache in the CLI credential directory; every failure is a miss. */
export function fileNativeBootstrapCache(
	opts?: CredentialStoreOpts & { now?: () => number },
): NativeBootstrapCache {
	const now = opts?.now ?? Date.now;
	const path = () =>
		join(credentialDirectory(opts), "mcp-native-bootstrap.json");
	const load = (): Entries => {
		try {
			const value: unknown = JSON.parse(readFileSync(path(), "utf8"));
			return value && typeof value === "object" ? (value as Entries) : {};
		} catch {
			return {};
		}
	};
	const fresh = (at: unknown, ttl: number) =>
		typeof at === "number" && at <= now() && now() - at <= ttl;
	/**
	 * Keys include each external-agent session, so entries a read would reject
	 * as expired must also leave the file; otherwise every CLI process parses
	 * and rewrites every session the machine ever ran (100 MB observed).
	 */
	const prune = (entries: Entries): Entries =>
		Object.fromEntries(
			Object.entries(entries).flatMap(([key, entry]) => {
				if (!entry || !fresh(entry.at, NATIVE_BOOTSTRAP_CACHE_TTL_MS))
					return [];
				const resolutions =
					entry.resolutions && typeof entry.resolutions === "object"
						? Object.fromEntries(
								Object.entries(entry.resolutions).filter(([, resolution]) =>
									fresh(resolution?.at, NATIVE_DESCRIPTOR_CACHE_TTL_MS),
								),
							)
						: undefined;
				return [[key, { ...entry, resolutions }]];
			}),
		);
	const save = (entries: Entries) => {
		try {
			mkdirSync(credentialDirectory(opts), { recursive: true, mode: 0o700 });
			const temporary = `${path()}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(prune(entries)), {
				mode: 0o600,
			});
			renameSync(temporary, path());
		} catch {
			// Caching is best effort.
		}
	};
	return {
		read(key) {
			const entry = load()[key];
			if (
				!entry ||
				typeof entry.at !== "number" ||
				now() - entry.at > NATIVE_BOOTSTRAP_CACHE_TTL_MS ||
				entry.at > now() ||
				!entry.bootstrap ||
				typeof entry.bootstrap !== "object" ||
				!entry.tools ||
				typeof entry.tools !== "object"
			)
				return undefined;
			const tools = Object.fromEntries(
				Object.entries(entry.tools).filter(
					(pair): pair is [string, string] => typeof pair[1] === "string",
				),
			);
			return {
				bootstrap: entry.bootstrap,
				tools,
				resolutions: entry.resolutions,
			};
		},
		write(key, entry) {
			const entries = load();
			const previous = entries[key];
			// Recording another tool name keeps the bootstrap's original age; a
			// fresh answer that replaces an expired entry starts a new one.
			const at =
				previous &&
				fresh(previous.at, NATIVE_BOOTSTRAP_CACHE_TTL_MS) &&
				JSON.stringify(previous.bootstrap) === JSON.stringify(entry.bootstrap)
					? previous.at
					: now();
			save({ ...entries, [key]: { ...entry, at } });
		},
		forget(key) {
			const entries = load();
			if (!(key in entries)) return;
			delete entries[key];
			save(entries);
		},
	};
}
