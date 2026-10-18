/** Private organization metadata and approved lesson catalog cache. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isObject, type JsonObject } from "./hook-io";

/** How long a cached read stands in for the live one. */
export const CACHE_TTL_MS = 10 * 60_000;
export type CacheKind = "organization" | "lessons" | "next-work";

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

/** The cached value for `key`, with its age, or undefined past CACHE_TTL_MS. */
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
		const ttl = kind === "next-work" ? 30_000 : CACHE_TTL_MS;
		if (!Number.isFinite(ageMs) || ageMs > ttl) return undefined;
		return { value: parsed.value, ageMs, fresh: true };
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
