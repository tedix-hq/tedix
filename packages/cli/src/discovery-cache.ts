/**
 * Local cache of a gateway's `server/discover` answer.
 *
 * Every CLI command is a new process, so the in-memory discovery would cost
 * each command one extra authenticated round trip (about 1-3 s on Connect)
 * before its real call. The answer only says which protocol version and
 * extensions the gateway speaks, which changes on deploys, not per command, so
 * a short-lived file cache is enough. A failed call drops the entry, so a
 * changed gateway costs at most one retry.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CredentialStoreOpts,
	credentialDirectory,
} from "./credential-store";

/** How long a discovery answer is reused. */
export const DISCOVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface DiscoveredProtocol {
	supportsTasks: boolean;
}

export interface DiscoveryCache {
	read(url: string): DiscoveredProtocol | undefined;
	write(url: string, protocol: DiscoveredProtocol): void;
	forget(url: string): void;
}

type Entries = Record<string, { supportsTasks: boolean; at: number }>;

/** File-backed cache in the CLI credential directory; every failure is a miss. */
export function fileDiscoveryCache(
	opts?: CredentialStoreOpts & { now?: () => number },
): DiscoveryCache {
	const now = opts?.now ?? Date.now;
	const path = () => join(credentialDirectory(opts), "mcp-discovery.json");
	const load = (): Entries => {
		try {
			const value: unknown = JSON.parse(readFileSync(path(), "utf8"));
			return value && typeof value === "object" ? (value as Entries) : {};
		} catch {
			return {};
		}
	};
	const save = (entries: Entries) => {
		try {
			mkdirSync(credentialDirectory(opts), { recursive: true, mode: 0o700 });
			const temporary = `${path()}.${process.pid}.tmp`;
			writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
			renameSync(temporary, path());
		} catch {
			// Caching is best effort.
		}
	};
	return {
		read(url) {
			const entry = load()[url];
			if (
				!entry ||
				typeof entry.supportsTasks !== "boolean" ||
				typeof entry.at !== "number" ||
				now() - entry.at > DISCOVERY_CACHE_TTL_MS ||
				entry.at > now()
			)
				return undefined;
			return { supportsTasks: entry.supportsTasks };
		},
		write(url, protocol) {
			save({
				...load(),
				[url]: { supportsTasks: protocol.supportsTasks, at: now() },
			});
		},
		forget(url) {
			const entries = load();
			if (!(url in entries)) return;
			delete entries[url];
			save(entries);
		},
	};
}

/**
 * True when a failed call suggests the gateway's protocol changed since the
 * cached discovery. Ordinary tool, auth or network failures keep the entry:
 * the cache is shared by every CLI process on the machine, so dropping it on
 * any error would make unrelated failures cost the next command a round trip.
 */
export function isStaleDiscoveryError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /unsupported (mcp )?protocol version|without advertising|"code":-32601/i.test(
		message,
	);
}
