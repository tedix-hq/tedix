import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developerInstallationManifest } from "./developer-example";

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

test("overlay CLI materializes the session-broker Cloudflare config and checks drift", () => {
	const root = mkdtempSync(join(tmpdir(), "tedix-overlay-cli-"));
	try {
		const manifest = structuredClone(developerInstallationManifest);
		manifest.workers[0]!.sourceConfig =
			"apps/session-broker/cloudflare.config.ts";
		manifest.workers[0]!.bindings = [];
		const manifestPath = join(root, "manifest.json");
		const output = join(root, "wrangler.json");
		const secrets = join(root, "secrets.json");
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const args = [
			process.execPath,
			join(import.meta.dir, "wrangler-overlay-cli.ts"),
			"--manifest",
			manifestPath,
			"--worker",
			"control-api",
			"--out",
			output,
			"--secrets-out",
			secrets,
		];
		const options = {
			cwd: resolve(import.meta.dir, "../../.."),
			env: { PATH: "/nonexistent", CLOUDFLARE_API_TOKEN: "" },
		};
		const generated = Bun.spawnSync(args, options);
		expect(generated.stderr.toString()).toBe("");
		expect(generated.exitCode).toBe(0);
		const config = JSON.parse(readFileSync(output, "utf8"));
		expect(config.main).toBe("src/index.ts");
		expect(config.name).toBe("acme-control-api");
		expect(config.account_id).toBe("example-cloudflare-account");
		expect(config.compatibility_flags).toContain("nodejs_compat");
		expect(config.exports).toEqual({
			SessionRotationOwner: { type: "durable-object", storage: "sqlite" },
			SessionIntentOwner: { type: "durable-object", storage: "sqlite" },
		});
		expect(config.vars.DESCOPE_BASE_URL).toBeUndefined();
		expect(config.services).toBeUndefined();
		const checked = Bun.spawnSync([...args, "--check"], options);
		expect(checked.stderr.toString()).toBe("");
		expect(checked.exitCode).toBe(0);
		writeFileSync(output, "{}\n");
		const drifted = Bun.spawnSync([...args, "--check"], options);
		expect(drifted.exitCode).not.toBe(0);
		expect(drifted.stderr.toString()).toContain("has drifted");
	} finally {
		rmSync(root, { recursive: true });
	}
});
