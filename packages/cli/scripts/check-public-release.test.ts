import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicRelease, fetchWithRetry } from "./check-public-release";

function releaseDir(version: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tedix-release-preflight-"));
	for (const name of [
		`tedix-${version}-darwin-arm64`,
		`tedix-${version}-darwin-x64`,
		`tedix-${version}-linux-arm64`,
		`tedix-${version}-linux-x64`,
		`tedix-${version}-windows-x64.exe`,
		"SHA256SUMS",
		"manifest.json",
		"verification.json",
	]) {
		writeFileSync(join(dir, name), name);
	}
	return dir;
}

function mockFetch(input: {
	existingPath?: string;
	latestStatus?: number;
	latestVersion?: string;
}): typeof fetch {
	return (async (request: string | URL | Request) => {
		const url = new URL(
			typeof request === "string"
				? request
				: request instanceof URL
					? request
					: request.url,
		);
		if (url.pathname === "/latest.json") {
			const status = input.latestStatus ?? 200;
			return new Response(
				status === 200
					? JSON.stringify({ version: input.latestVersion ?? "0.1.0-beta.0" })
					: null,
				{ status },
			);
		}
		return new Response(null, {
			status: url.pathname === input.existingPath ? 200 : 404,
		});
	}) as typeof fetch;
}

describe("checkPublicRelease", () => {
	test("retries a transient transport failure", async () => {
		let attempts = 0;
		const response = await fetchWithRetry(
			(async () => {
				attempts++;
				if (attempts === 1) throw new Error("ECONNRESET");
				return new Response(null, { status: 404 });
			}) as typeof fetch,
			"https://downloads.tedix.dev/release",
			undefined,
			{ retryDelayMs: 0 },
		);
		expect(response.status).toBe(404);
		expect(attempts).toBe(2);
	});

	test("allows the first release when every immutable path is absent", async () => {
		const result = await checkPublicRelease({
			distDir: releaseDir("0.1.0-beta.1"),
			fetch: mockFetch({ latestStatus: 404 }),
			nonce: "source-sha",
			version: "0.1.0-beta.1",
		});
		expect(result).toEqual({
			previousVersion: null,
			version: "0.1.0-beta.1",
		});
	});

	test("refuses an existing immutable release path", async () => {
		await expect(
			checkPublicRelease({
				distDir: releaseDir("0.1.0-beta.1"),
				fetch: mockFetch({
					existingPath:
						"/releases/0.1.0-beta.1/tedix-0.1.0-beta.1-darwin-arm64",
					latestStatus: 404,
				}),
				nonce: "source-sha",
				version: "0.1.0-beta.1",
			}),
		).rejects.toThrow("Refusing to overwrite immutable release object");
	});

	test("allows only a strictly newer latest pointer", async () => {
		await expect(
			checkPublicRelease({
				distDir: releaseDir("0.1.0-beta.1"),
				fetch: mockFetch({ latestVersion: "0.1.0" }),
				nonce: "source-sha",
				version: "0.1.0-beta.1",
			}),
		).rejects.toThrow(
			"Refusing to move latest.json from 0.1.0 to 0.1.0-beta.1",
		);
	});
});
