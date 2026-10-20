import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileGatewayCooldown } from "./gateway-cooldown";
import { retryRateLimitedPosts } from "./gateway-retry";

test("cooldown markers are readable and extendable from another process", () => {
	const configDir = mkdtempSync(join(tmpdir(), "gateway-cooldown-process-"));
	try {
		const store = fileGatewayCooldown({ configDir });
		store.extend("https://fixture.example/mcp", 60_000);
		const child = spawnSync(
			process.execPath,
			[
				"-e",
				`
			import { fileGatewayCooldown } from ${JSON.stringify(new URL("./gateway-cooldown.ts", import.meta.url).href)};
			const store = fileGatewayCooldown({ configDir: ${JSON.stringify(configDir)} });
			console.log(store.read("https://fixture.example/mcp"));
			store.extend("https://fixture.example/mcp", 120_000);
		`,
			],
			{ encoding: "utf8" },
		);
		expect(child.status).toBe(0);
		expect(child.stdout.trim()).toBe("60000");
		expect(store.read("https://fixture.example/mcp")).toBe(120_000);
		const marker = readdirSync(configDir).find((name) =>
			name.endsWith(".json"),
		)!;
		writeFileSync(join(configDir, marker), "broken-json");
		expect(store.read("https://fixture.example/mcp")).toBe(0);
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
});

test("non-retryable refusals still publish numeric and HTTP-date Retry-After", async () => {
	const configDir = mkdtempSync(join(tmpdir(), "gateway-cooldown-headers-"));
	try {
		const now = Date.parse("2026-01-01T00:00:00Z");
		for (const header of ["600", "Thu, 01 Jan 2026 00:10:00 GMT"]) {
			const cooldown = fileGatewayCooldown({ configDir });
			const call = retryRateLimitedPosts(
				async () =>
					new Response("limited", {
						status: 429,
						headers: { "Retry-After": header },
					}),
				{
					cooldown,
					now: () => now,
				},
			);
			// GETs are never replayed, but their refusal protects sibling POSTs.
			expect(
				(
					await call(
						`https://${header === "600" ? "numeric" : "date"}.example/mcp`,
					)
				).status,
			).toBe(429);
			expect(
				cooldown.read(
					`https://${header === "600" ? "numeric" : "date"}.example/mcp`,
				),
			).toBe(now + 600_000);
		}
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
});
