import { describe, expect, test } from "bun:test";
import { developerInstallationManifest } from "./developer-example";
import { preflightCloudflareAccount, renderPreflightReport } from "./preflight";

const ACCOUNT_ID = "example-cloudflare-account";
const ZONE_ID = "example-cloudflare-zone";

interface RecordedRequest {
	url: string;
	method: string;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fakeCloudflare(
	overrides: Record<string, () => Response> = {},
	requests: RecordedRequest[] = [],
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, method: init?.method ?? "GET" });
		const path = new URL(url).pathname + new URL(url).search;
		for (const [suffix, respond] of Object.entries(overrides)) {
			if (path.includes(suffix)) return respond();
		}
		if (path === `/client/v4/zones/${ZONE_ID}`) {
			return jsonResponse(200, {
				success: true,
				result: {
					name: "example.invalid",
					account: { id: ACCOUNT_ID },
				},
			});
		}
		return jsonResponse(200, { success: true, result: [] });
	}) as typeof fetch;
}

describe("preflightCloudflareAccount", () => {
	test("passes when every probe answers and never issues a non-GET request", async () => {
		const requests: RecordedRequest[] = [];
		const report = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({}, requests),
		});
		expect(report.ok).toBe(true);
		expect(report.mutationAllowed).toBe(true);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
		expect(report.checks.map((check) => check.id)).toEqual([
			"account:developer-account",
			"capability:developer-account:ai",
			"capability:developer-account:assets",
			"capability:developer-account:browser",
			"capability:developer-account:container",
			"capability:developer-account:d1",
			"capability:developer-account:durable-object",
			"capability:developer-account:hyperdrive",
			"capability:developer-account:kv",
			"capability:developer-account:queue",
			"capability:developer-account:r2",
			"capability:developer-account:service",
			"capability:developer-account:vectorize",
			"capability:developer-account:workflow",
			"zone:application-domain",
		]);
	});

	test("fresh-account certification fails before mutation when prior workers exist", async () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			cloudflare: { accounts: Array<{ freshAccount?: boolean }> };
		};
		manifest.cloudflare.accounts[0]!.freshAccount = true;
		const requests: RecordedRequest[] = [];
		const report = await preflightCloudflareAccount({
			manifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare(
				{
					"/workers/scripts": () =>
						jsonResponse(200, {
							success: true,
							result: [{ id: "old-worker" }],
						}),
				},
				requests,
			),
		});

		expect(report.ok).toBe(false);
		expect(report.mutationAllowed).toBe(false);
		expect(
			report.checks.find(
				(check) => check.id === "freshness:developer-account:workers-scripts",
			),
		).toMatchObject({
			status: "error",
			detail:
				"fresh-account certification requires no existing Worker scripts; found at least 1",
		});
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	test("fresh-account certification accepts Cloudflare's empty R2 bucket envelope", async () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			cloudflare: { accounts: Array<{ freshAccount?: boolean }> };
		};
		manifest.cloudflare.accounts[0]!.freshAccount = true;
		const report = await preflightCloudflareAccount({
			manifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({
				"/r2/buckets": () =>
					jsonResponse(200, {
						success: true,
						result: { buckets: [] },
					}),
			}),
		});

		expect(report.ok).toBe(true);
		expect(
			report.checks.find(
				(check) => check.id === "freshness:developer-account:r2-buckets",
			)?.status,
		).toBe("ok");
	});

	test("fails closed when a required capability probe is forbidden", async () => {
		const report = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({
				"/d1/database": () =>
					jsonResponse(403, {
						success: false,
						errors: [{ code: 10000, message: "Authentication error" }],
					}),
			}),
		});
		expect(report.ok).toBe(false);
		expect(report.mutationAllowed).toBe(false);
		const check = report.checks.find(
			(entry) => entry.id === "capability:developer-account:d1",
		);
		expect(check?.status).toBe("forbidden");
		expect(check?.httpStatus).toBe(403);
		expect(check?.detail).toContain("10000");
	});

	test("tolerates a missing optional capability but records it", async () => {
		const report = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({
				// The developer example declares kv, queue, browser, vectorize,
				// hyperdrive, and container as optional; probe one of them missing.
				"/hyperdrive/configs": () =>
					jsonResponse(404, {
						success: false,
						errors: [{ code: 1000, message: "not found" }],
					}),
			}),
		});
		expect(report.ok).toBe(true);
		const check = report.checks.find(
			(entry) => entry.id === "capability:developer-account:hyperdrive",
		);
		expect(check?.status).toBe("unavailable");
		expect(check?.requirement).toBe("optional");
	});

	test("fails closed on network errors for required capabilities", async () => {
		const report = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({
				"/workers/scripts": () => {
					throw new Error("connect timeout");
				},
			}),
		});
		expect(report.ok).toBe(false);
		const check = report.checks.find(
			(entry) => entry.id === "capability:developer-account:service",
		);
		expect(check?.status).toBe("error");
		expect(check?.detail).toBe("connect timeout");
	});

	test("fails when the declared hostname is outside the zone", async () => {
		const report = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({
				[`/zones/${ZONE_ID}`]: () =>
					jsonResponse(200, {
						success: true,
						result: {
							name: "other.invalid",
							account: { id: ACCOUNT_ID },
						},
					}),
			}),
		});
		expect(report.ok).toBe(false);
		const check = report.checks.find(
			(entry) => entry.id === "zone:application-domain",
		);
		expect(check?.status).toBe("error");
		expect(check?.detail).toContain("not inside zone");
	});

	test("fails when the zone belongs to a different account", async () => {
		const report = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({
				[`/zones/${ZONE_ID}`]: () =>
					jsonResponse(200, {
						success: true,
						result: {
							name: "example.invalid",
							account: { id: "someone-else" },
						},
					}),
			}),
		});
		expect(report.ok).toBe(false);
		const check = report.checks.find(
			(entry) => entry.id === "zone:application-domain",
		);
		expect(check?.status).toBe("error");
		expect(check?.detail).toContain("someone-else");
	});

	test("fails with an unresolved status when coordinates are unresolved", async () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			cloudflare: {
				accounts: Array<{ accountId: unknown }>;
				domains: Array<{ zoneId: unknown }>;
			};
		};
		manifest.cloudflare.accounts[0]!.accountId = {
			state: "unresolved",
			key: "developer-account-id",
			reason: "operator has not supplied the account",
		};
		manifest.cloudflare.domains[0]!.zoneId = {
			state: "unresolved",
			key: "application-zone-id",
			reason: "operator has not supplied the zone",
		};
		const requests: RecordedRequest[] = [];
		const report = await preflightCloudflareAccount({
			manifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({}, requests),
		});
		expect(report.ok).toBe(false);
		expect(requests).toHaveLength(0);
		expect(report.checks.every((check) => check.status === "unresolved")).toBe(
			true,
		);
	});

	test("rejects an invalid manifest before any network request", async () => {
		const requests: RecordedRequest[] = [];
		await expect(
			preflightCloudflareAccount({
				manifest: { schemaVersion: "1.0" },
				apiToken: "test-token",
				fetchImplementation: fakeCloudflare({}, requests),
			}),
		).rejects.toThrow("Installation manifest preflight failed");
		expect(requests).toHaveLength(0);
	});
});

describe("renderPreflightReport", () => {
	test("summarizes pass and fail outcomes", async () => {
		const passing = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare(),
		});
		expect(renderPreflightReport(passing)).toContain(
			"PASS: every required capability is available",
		);
		const failing = await preflightCloudflareAccount({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({
				"/d1/database": () => jsonResponse(403, { success: false }),
			}),
		});
		expect(renderPreflightReport(failing)).toContain(
			"FAIL: required capabilities are missing; refusing before mutation",
		);
	});
});
