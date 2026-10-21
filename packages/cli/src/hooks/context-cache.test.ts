import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_TTL_MS, cacheDir, readCache, writeCache } from "./context-cache";

const writtenAt = new Date("2026-10-21T12:00:00.000Z");
const keys: [string, string] = [
	"organization:fictional-alpha/workspace:one",
	"organization:fictional-beta/workspace:two",
];
const kinds = ["organization", "lessons", "next-work"] as const;

function withConfig(run: (env: NodeJS.ProcessEnv) => void): void {
	const config = mkdtempSync(join(tmpdir(), "tedix-context-cache-"));
	try {
		run({ TEDIX_CONFIG_DIR: config });
	} finally {
		rmSync(config, { recursive: true, force: true });
	}
}

function entryPath(env: NodeJS.ProcessEnv, kind: string, key: string): string {
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return join(cacheDir(env), `${kind}-${digest}.json`);
}

test("round trips every cache kind and keeps organization/workspace scopes isolated", () => {
	withConfig((env) => {
		for (const kind of kinds) {
			writeCache(env, kind, keys[0], { kind, scope: "alpha" }, writtenAt);
			writeCache(env, kind, keys[1], { kind, scope: "beta" }, writtenAt);

			expect(readCache(env, kind, keys[0], writtenAt)).toEqual({
				value: { kind, scope: "alpha" },
				ageMs: 0,
				fresh: true,
			});
			expect(readCache(env, kind, keys[1], writtenAt)?.value).toEqual({
				kind,
				scope: "beta",
			});
		}

		const names = readdirSync(cacheDir(env));
		expect(names).toHaveLength(kinds.length * keys.length);
		for (const name of names) {
			expect(name).not.toContain(keys[0]);
			expect(name).not.toContain(keys[1]);
			expect(name).toMatch(
				/^(organization|lessons|next-work)-[0-9a-f]{32}\.json$/,
			);
		}
	});
});

test("enforces the exact TTL boundary, expiry and clock skew for each kind", () => {
	withConfig((env) => {
		for (const kind of kinds) {
			const ttl = kind === "next-work" ? 30_000 : CACHE_TTL_MS;
			writeCache(env, kind, keys[0], { kind }, writtenAt);

			expect(readCache(env, kind, keys[0], new Date(+writtenAt + ttl))).toEqual(
				{
					value: { kind },
					ageMs: ttl,
					fresh: true,
				},
			);
			expect(
				readCache(env, kind, keys[0], new Date(+writtenAt + ttl + 1)),
			).toBeUndefined();
			expect(readCache(env, kind, keys[0], new Date(+writtenAt - 1))).toEqual({
				value: { kind },
				ageMs: 0,
				fresh: true,
			});
		}
	});
});

test("rejects malformed, invalid and mismatched cache entries without throwing", () => {
	withConfig((env) => {
		const key = keys[0];
		const path = entryPath(env, "organization", key);
		mkdirSync(cacheDir(env), { recursive: true });
		const invalidEntries: unknown[] = [
			"not an object",
			[],
			{ key, writtenAt: "not-a-date", value: { ok: true } },
			{
				key: "different-key",
				writtenAt: writtenAt.toISOString(),
				value: { ok: true },
			},
			{ key, writtenAt: writtenAt.toISOString(), value: [] },
		];

		for (const entry of invalidEntries) {
			writeFileSync(path, JSON.stringify(entry));
			expect(() =>
				readCache(env, "organization", key, writtenAt),
			).not.toThrow();
			expect(readCache(env, "organization", key, writtenAt)).toBeUndefined();
		}

		writeFileSync(path, "{ definitely not json");
		expect(readCache(env, "organization", key, writtenAt)).toBeUndefined();
	});
});

test("does not throw for absent or unreadable entries", () => {
	withConfig((env) => {
		const key = keys[0];
		expect(readCache(env, "lessons", key, writtenAt)).toBeUndefined();

		mkdirSync(entryPath(env, "lessons", key), { recursive: true });
		expect(readCache(env, "lessons", key, writtenAt)).toBeUndefined();
	});
});

test("creates private cache directories and files on POSIX hosts", () => {
	if (process.platform === "win32") return;
	withConfig((env) => {
		writeCache(env, "organization", keys[0], { private: true }, writtenAt);
		expect(statSync(cacheDir(env)).mode & 0o777).toBe(0o700);
		expect(statSync(entryPath(env, "organization", keys[0])).mode & 0o777).toBe(
			0o600,
		);
	});
});

test("completed writes are complete JSON and leave no temporary files", () => {
	withConfig((env) => {
		for (let i = 0; i < 25; i++) {
			writeCache(
				env,
				"next-work",
				keys[0],
				{ sequence: i, complete: true },
				writtenAt,
			);
			const path = entryPath(env, "next-work", keys[0]);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				key: keys[0],
				writtenAt: writtenAt.toISOString(),
				value: { sequence: i, complete: true },
			});
			expect(readCache(env, "next-work", keys[0], writtenAt)?.value).toEqual({
				sequence: i,
				complete: true,
			});
		}
		expect(readdirSync(cacheDir(env))).toEqual([
			"next-work-" +
				createHash("sha256").update(keys[0]).digest("hex").slice(0, 32) +
				".json",
		]);
	});
});
