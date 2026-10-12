import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
	NATIVE_BOOTSTRAP_CACHE_TTL_MS,
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

	it("drops forgotten entries", () => {
		const store = cache(() => 1_000);
		store.write(KEY, { bootstrap, tools: {} });
		store.forget(KEY);
		expect(store.read(KEY)).toBeUndefined();
	});
});
