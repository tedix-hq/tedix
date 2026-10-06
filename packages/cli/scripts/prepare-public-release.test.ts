import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePublicRelease } from "./prepare-public-release";

describe("preparePublicRelease", () => {
	test("creates deterministic checksums and public manifests", () => {
		const root = mkdtempSync(join(tmpdir(), "tedix-public-release-"));
		const distDir = join(root, "dist");
		mkdirSync(distDir);
		writeFileSync(join(root, "install.sh"), "#!/bin/sh\n");
		for (const name of [
			"tedix-0.1.0-darwin-arm64",
			"tedix-0.1.0-darwin-x64",
			"tedix-0.1.0-linux-arm64",
			"tedix-0.1.0-linux-x64",
			"tedix-0.1.0-windows-x64.exe",
		]) {
			writeFileSync(join(distDir, name), name);
		}

		const result = preparePublicRelease({
			distDir,
			packageDir: root,
			sourceSha: "a".repeat(40),
			version: "0.1.0",
		});

		expect(result.assets.map((asset) => asset.name)).toEqual([
			"tedix-0.1.0-darwin-arm64",
			"tedix-0.1.0-darwin-x64",
			"tedix-0.1.0-linux-arm64",
			"tedix-0.1.0-linux-x64",
			"tedix-0.1.0-windows-x64.exe",
		]);
		expect(readFileSync(join(distDir, "SHA256SUMS"), "utf8")).toMatch(
			/^[0-9a-f]{64}  tedix-0\.1\.0-darwin-arm64/m,
		);
		expect(
			JSON.parse(readFileSync(join(distDir, "manifest.json"), "utf8")),
		).toMatchObject({
			version: "0.1.0",
			sourceSha: "a".repeat(40),
			verificationUrl:
				"https://downloads.tedix.dev/releases/0.1.0/verification.json",
		});
		expect(
			JSON.parse(readFileSync(join(distDir, "verification.json"), "utf8")),
		).toEqual({
			schemaVersion: 1,
			version: "0.1.0",
			tag: "cli-v0.1.0",
			sourceSha: "a".repeat(40),
			checks: [
				{ id: "test:run", status: "passed" },
				{ id: "type-check", status: "passed" },
				{ id: "test:protocol", status: "passed" },
				{ id: "test:standalone", status: "passed" },
				{ id: "test:installer", status: "passed" },
			],
		});
		expect(
			JSON.parse(readFileSync(join(distDir, "latest.json"), "utf8")),
		).toEqual({
			schemaVersion: 1,
			version: "0.1.0",
			sourceSha: "a".repeat(40),
			manifestUrl: "https://downloads.tedix.dev/releases/0.1.0/manifest.json",
			verificationUrl:
				"https://downloads.tedix.dev/releases/0.1.0/verification.json",
			installerUrl: "https://downloads.tedix.dev/install.sh",
		});
		expect(readFileSync(join(distDir, "install.sh"), "utf8")).toBe(
			"#!/bin/sh\n",
		);
	});
});
