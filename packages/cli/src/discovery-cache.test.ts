import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { DISCOVERY_CACHE_TTL_MS, fileDiscoveryCache } from "./discovery-cache";

const URL_A = "https://gateway.example.test/mcp";
const URL_B = "https://other.example.test/mcp";

function cache(now: () => number) {
	const configDir = mkdtempSync(join(tmpdir(), "tedix-discovery-"));
	return fileDiscoveryCache({ configDir, now });
}

describe("fileDiscoveryCache", () => {
	it("reuses a fresh answer per gateway URL", () => {
		let now = 1_000;
		const store = cache(() => now);
		expect(store.read(URL_A)).toBeUndefined();
		store.write(URL_A, { supportsTasks: true });
		store.write(URL_B, { supportsTasks: false });
		now += 60_000;
		expect(store.read(URL_A)).toEqual({ supportsTasks: true });
		expect(store.read(URL_B)).toEqual({ supportsTasks: false });
	});

	it("expires answers after the TTL and drops forgotten ones", () => {
		let now = 1_000;
		const store = cache(() => now);
		store.write(URL_A, { supportsTasks: true });
		store.write(URL_B, { supportsTasks: true });
		store.forget(URL_B);
		expect(store.read(URL_B)).toBeUndefined();
		now += DISCOVERY_CACHE_TTL_MS + 1;
		expect(store.read(URL_A)).toBeUndefined();
	});
});
