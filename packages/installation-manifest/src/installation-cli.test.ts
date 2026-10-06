import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("installation CLI credential-free paths", () => {
	for (const flag of [
		"--os-url",
		"--descope-base-url",
		"--descope-management-api-base",
	]) {
		test(`provision rejects removed ${flag} before reading credentials`, () => {
			const result = Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "provision-cli.ts"),
					flag,
					"https://wrong.example.com",
				],
				{ env: { PATH: "/nonexistent", CLOUDFLARE_API_TOKEN: "" } },
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.toString()).toContain(`unknown option: ${flag}`);
			expect(result.stderr.toString()).not.toContain("Could not read Wrangler");
		});
	}
	for (const script of ["preflight-cli.ts", "provision-cli.ts"]) {
		test(`${script} help does not need executables or credentials`, () => {
			const result = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, script), "--help"],
				{ env: { PATH: "/nonexistent", CLOUDFLARE_API_TOKEN: "" } },
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("bunx wrangler login");
			expect(result.stderr.toString()).toBe("");
		});
		test(`${script} validates missing option and manifest before credentials`, () => {
			for (const args of [
				["--manifest"],
				["--manifest", "first.json", "--manifest", "second.json"],
				["--json", "--json"],
				["--manifest", "/nonexistent-manifest.json"],
			]) {
				const result = Bun.spawnSync(
					[process.execPath, join(import.meta.dir, script), ...args],
					{ env: { PATH: "/nonexistent", CLOUDFLARE_API_TOKEN: "" } },
				);
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr.toString()).not.toContain(
					"Could not read Wrangler",
				);
			}
		});
	}
});
