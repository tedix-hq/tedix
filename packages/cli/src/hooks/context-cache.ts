/**
 * Local cache for the slow-changing reads of the prompt-context hook: the
 * working-preferences document, the approved team lessons and the credential's
 * live organization id. One small JSON file per entry under
 * `~/.tedix/hook-cache/`, named by a hash of its key (profile, organization,
 * signed-in user and the read's own identifiers; never a token or prompt text).
 *
 * A fresh organization entry (within CACHE_TTL_MS) replaces its live probe.
 * Preferences and lessons are checked live each turn so changes are visible;
 * a copy up to CACHE_MAX_AGE_MS covers a failed read. Anything older is ignored.
 * Age comes from the entry's own write time. Cache faults behave like misses.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isObject, type JsonObject } from "./hook-io";

/** How long a cached read stands in for the live one. */
export const CACHE_TTL_MS = 10 * 60_000;
/** How long a stale copy still covers a failed live read. */
export const CACHE_MAX_AGE_MS = 60 * 60_000;

export type CacheKind = "preferences" | "lessons" | "organization";

export interface CacheEntry {
	value: JsonObject;
	/** Milliseconds since the entry was written. */
	ageMs: number;
	fresh: boolean;
}

export function cacheDir(env: NodeJS.ProcessEnv): string {
	return join(env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"), "hook-cache");
}

function entryPath(
	env: NodeJS.ProcessEnv,
	kind: CacheKind,
	key: string,
): string {
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return join(cacheDir(env), `${kind}-${digest}.json`);
}

/** The cached value for `key`, with its age, or undefined past CACHE_MAX_AGE_MS. */
export function readCache(
	env: NodeJS.ProcessEnv,
	kind: CacheKind,
	key: string,
	now: Date,
): CacheEntry | undefined {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(entryPath(env, kind, key), "utf8"),
		);
		if (!isObject(parsed) || parsed.key !== key || !isObject(parsed.value))
			return undefined;
		// Clock skew counts as age zero.
		const ageMs = Math.max(0, now.getTime() - Date.parse(parsed.writtenAt));
		if (!Number.isFinite(ageMs) || ageMs > CACHE_MAX_AGE_MS) return undefined;
		return { value: parsed.value, ageMs, fresh: ageMs <= CACHE_TTL_MS };
	} catch {
		return undefined;
	}
}

/** Store `value` for `key`, atomically and private to the user. Never throws. */
export function writeCache(
	env: NodeJS.ProcessEnv,
	kind: CacheKind,
	key: string,
	value: JsonObject,
	now: Date,
): void {
	try {
		const path = entryPath(env, kind, key);
		mkdirSync(cacheDir(env), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(
			temporary,
			JSON.stringify({ key, writtenAt: now.toISOString(), value }),
			{ mode: 0o600 },
		);
		renameSync(temporary, path);
	} catch {}
}
