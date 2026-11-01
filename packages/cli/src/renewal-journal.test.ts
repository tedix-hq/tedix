import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshStoredSession, WorkspaceOAuthProvider } from "./oauth-provider";
import { isolateRenewalTests } from "./renewal-test-env";

isolateRenewalTests();

for (const workspace of [undefined, "journal-fixture"]) {
	test(`renewal journal identifies ${workspace ?? "test"} in TEDIX_CONFIG_DIR`, async () => {
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: "https://fixture.example/mcp",
			workspace,
			loadStored: false,
		});
		expect(await refreshStoredSession(provider)).toBe("unavailable");
		const journal = join(process.env.TEDIX_CONFIG_DIR!, "renewals.log");
		expect(JSON.parse(readFileSync(journal, "utf8")).workspace).toBe(
			workspace ?? "test",
		);
	});
}

test("renewal journal rotation stays in TEDIX_CONFIG_DIR", async () => {
	const journal = join(process.env.TEDIX_CONFIG_DIR!, "renewals.log");
	const previous = "x".repeat(1_000_001);
	writeFileSync(journal, previous);
	const provider = new WorkspaceOAuthProvider({
		mcpUrl: "https://fixture.example/mcp",
		loadStored: false,
	});
	expect(await refreshStoredSession(provider)).toBe("unavailable");
	expect(readFileSync(`${journal}.1`, "utf8")).toBe(previous);
	expect(JSON.parse(readFileSync(journal, "utf8")).workspace).toBe("test");
});
