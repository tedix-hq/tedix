import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ThreadStoreOpts {
	configDir?: string;
	homeDir?: string;
	/** Exact live organization UUID; never a display name or routing alias. */
	organizationId?: string;
}

interface ThreadStore {
	version: 1;
	threads: Record<string, string>;
}

function resolveThreadDir(opts?: ThreadStoreOpts): string {
	return (
		opts?.configDir ??
		process.env.TEDIX_CONFIG_DIR ??
		join(opts?.homeDir ?? homedir(), ".tedix")
	);
}

function resolveThreadPath(opts?: ThreadStoreOpts): string {
	return join(resolveThreadDir(opts), "threads.json");
}

function emptyStore(): ThreadStore {
	return { version: 1, threads: {} };
}

// Single read path. Fail-soft: corrupt/unreadable files surface a diagnostic and
// resolve to an empty store; non-string entries are dropped while valid siblings
// survive.
function loadStore(opts?: ThreadStoreOpts): ThreadStore {
	const path = resolveThreadPath(opts);
	if (!existsSync(path)) return emptyStore();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return emptyStore();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// The threads file exists but is not valid JSON — surface a clear
		// diagnostic so the user knows their saved aliases were reset.
		console.error(
			"[tedix] threads.json is corrupt or unreadable — saved conversation aliases were reset.",
		);
		return emptyStore();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		console.error(
			"[tedix] threads.json is corrupt or unreadable — saved conversation aliases were reset.",
		);
		return emptyStore();
	}
	const obj = parsed as Record<string, unknown>;
	const threads: Record<string, string> = {};
	const threadsRaw = obj.threads;
	if (typeof threadsRaw === "object" && threadsRaw !== null) {
		for (const [name, value] of Object.entries(
			threadsRaw as Record<string, unknown>,
		)) {
			if (typeof value === "string") threads[name] = value;
		}
	}
	return { version: 1, threads };
}

// Single write path. Preserves the perms hardening of the credential store.
function saveStore(store: ThreadStore, opts?: ThreadStoreOpts): void {
	const dir = resolveThreadDir(opts);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = resolveThreadPath(opts);
	writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
	chmodSync(path, 0o600);
}

function threadKey(name: string, opts?: ThreadStoreOpts): string {
	return opts?.organizationId
		? JSON.stringify([opts.organizationId, name])
		: name;
}

export function resolveThread(
	name: string,
	opts?: ThreadStoreOpts,
): string | null {
	const store = loadStore(opts);
	// Absence is normal (no diagnostic).
	return store.threads[threadKey(name, opts)] ?? null;
}

export function setThread(
	name: string,
	conversationId: string,
	opts?: ThreadStoreOpts,
): void {
	const store = loadStore(opts);
	store.threads[threadKey(name, opts)] = conversationId;
	saveStore(store, opts);
}

export function listThreads(
	opts?: ThreadStoreOpts,
): Array<{ name: string; conversationId: string }> {
	const store = loadStore(opts);
	return Object.entries(store.threads)
		.flatMap<[string, string]>(([key, conversationId]) => {
			if (!opts?.organizationId)
				return key.startsWith("[") ? [] : [[key, conversationId]];
			try {
				const parsed = JSON.parse(key);
				return Array.isArray(parsed) &&
					parsed.length === 2 &&
					parsed[0] === opts.organizationId &&
					typeof parsed[1] === "string"
					? [[parsed[1], conversationId]]
					: [];
			} catch {
				return [];
			}
		})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, conversationId]) => ({ name, conversationId }));
}
