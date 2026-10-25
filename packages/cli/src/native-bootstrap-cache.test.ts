import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	NATIVE_BOOTSTRAP_CACHE_TTL_MS,
	NATIVE_DESCRIPTOR_CACHE_TTL_MS,
	fileNativeBootstrapCache,
} from "./native-bootstrap-cache";

const KEY = "https://gateway.example.test/mcp|test|org-1";
const bootstrap = {
	nativeContext: { organizationId: "org-1" },
	nativeCatalog: {},
};

function cache(now: () => number) {
	const configDir = mkdtempSync(join(tmpdir(), "tedix-native-bootstrap-"));
	return fileNativeBootstrapCache({ configDir, now });
}

describe("fileNativeBootstrapCache", () => {
	it("keeps the bootstrap's age when tool names are added", () => {
		let now = 1_000;
		const store = cache(() => now);
		store.write(KEY, { bootstrap, tools: {} });
		now += NATIVE_BOOTSTRAP_CACHE_TTL_MS - 10;
		store.write(KEY, { bootstrap, tools: { "work.get_x": "tool_x" } });
		expect(store.read(KEY)?.tools).toEqual({ "work.get_x": "tool_x" });
		now += 20;
		expect(store.read(KEY)).toBeUndefined();
	});

	it("removes expired sessions and descriptors from the file on the next write", () => {
		let now = 1_000;
		const configDir = mkdtempSync(join(tmpdir(), "tedix-native-bootstrap-"));
		const store = fileNativeBootstrapCache({ configDir, now: () => now });
		const resolution = (at: number) => ({
			at,
			catalogHash: "h",
			row: {},
			detail: {},
		});
		store.write(`${KEY}|old-session`, {
			bootstrap,
			tools: {},
			resolutions: { "work.old": resolution(now) },
		});
		now += NATIVE_BOOTSTRAP_CACHE_TTL_MS + 1;
		store.write(KEY, {
			bootstrap,
			tools: {},
			resolutions: {
				"work.stale": resolution(now - NATIVE_DESCRIPTOR_CACHE_TTL_MS - 1),
				"work.current": resolution(now),
			},
		});
		const file = JSON.parse(
			readFileSync(join(configDir, "mcp-native-bootstrap.json"), "utf8"),
		);
		expect(Object.keys(file)).toEqual([KEY]);
		expect(Object.keys(file[KEY].resolutions)).toEqual(["work.current"]);
	});

	it("restarts the age of an expired entry when a fresh answer replaces it", () => {
		let now = 1_000;
		const store = cache(() => now);
		store.write(KEY, { bootstrap, tools: {} });
		now += NATIVE_BOOTSTRAP_CACHE_TTL_MS + 1;
		expect(store.read(KEY)).toBeUndefined();
		store.write(KEY, { bootstrap, tools: {} });
		expect(store.read(KEY)?.bootstrap).toEqual(bootstrap);
	});

	it("drops forgotten entries", () => {
		const store = cache(() => 1_000);
		store.write(KEY, { bootstrap, tools: {} });
		store.forget(KEY);
		expect(store.read(KEY)).toBeUndefined();
	});
});
