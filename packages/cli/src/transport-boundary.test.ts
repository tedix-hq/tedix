import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceDir = new URL(".", import.meta.url).pathname;
const productionFiles = readdirSync(sourceDir)
	.filter((name) => /\.(?:ts|tsx)$/.test(name) && !name.endsWith(".test.ts"))
	.map((name) => ({
		name,
		text: readFileSync(join(sourceDir, name), "utf8"),
	}));

// Account discovery through the gateway's Code Mode is behaviour-tested in
// account.test.ts; this file keeps the import and removed-path boundary.
describe("CLI transport boundary", () => {
	test("has no direct API client transport", () => {
		const directRpcFiles = productionFiles
			.filter(({ text }) => text.includes("@tedix/api-client"))
			.map(({ name }) => name);
		expect(directRpcFiles).toEqual([]);
	});

	test("normal CLI source has no removed product transport paths", () => {
		const forbidden = [
			"enqueueViaApi",
			"mcpOrApiRead",
			"sendOneViaApi",
			"startKernelWsStream",
			"/kernel/acp",
			"issueEphemeralMcpCredential",
			"TEDIX_API_KEY",
		];
		const violations = productionFiles.flatMap(({ name, text }) =>
			forbidden
				.filter((term) => text.includes(term))
				.map((term) => `${name}:${term}`),
		);
		expect(violations).toEqual([]);
	});
});
