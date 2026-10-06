import { describe, expect, test } from "bun:test";
import { developerInstallationManifest } from "./developer-example";
import {
	bootstrapPlan,
	executeD1Statements,
	IdentityReadinessRefusedError,
	provisionCloudflareResources,
	ProvisioningRefusedError,
	renderProvisionReport,
} from "./provision";

const ACCOUNT_ID = "example-cloudflare-account";
const ZONE_ID = "example-cloudflare-zone";

interface RecordedRequest {
	url: string;
	method: string;
	body?: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Fake Cloudflare API: preflight probes and zone reads succeed, resource
 * existence checks report nothing present, creates succeed. Overrides match
 * by first path substring hit, keyed on `METHOD path-fragment`.
 */
function fakeCloudflare(
	overrides: Record<string, (request: RecordedRequest) => Response> = {},
	requests: RecordedRequest[] = [],
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body =
			typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const request: RecordedRequest = { url, method, body };
		requests.push(request);
		const path = new URL(url).pathname + new URL(url).search;
		for (const [key, respond] of Object.entries(overrides)) {
			const spaceIndex = key.indexOf(" ");
			const wantMethod = key.slice(0, spaceIndex);
			const fragment = key.slice(spaceIndex + 1);
			if (method === wantMethod && path.includes(fragment)) {
				return respond(request);
			}
		}
		if (path === `/client/v4/zones/${ZONE_ID}`) {
			return jsonResponse(200, {
				success: true,
				result: { name: "example.invalid", account: { id: ACCOUNT_ID } },
			});
		}
		if (method === "POST" && path.includes("/d1/database")) {
			return jsonResponse(200, {
				success: true,
				result: { uuid: "created-d1-uuid", name: body?.name },
			});
		}
		if (method === "POST" && path.includes("/storage/kv/namespaces")) {
			return jsonResponse(200, {
				success: true,
				result: { id: "created-kv-id", title: body?.title },
			});
		}
		if (method === "POST") {
			return jsonResponse(200, { success: true, result: {} });
		}
		if (
			method === "GET" &&
			(path.includes("/r2/buckets/") ||
				path.includes("/vectorize/v2/indexes/") ||
				path.includes("/storage/kv/namespaces/"))
		) {
			// Specific-resource existence probes: nothing exists yet. The
			// capability preflight uses the LIST forms, which stay 200 below.
			return jsonResponse(404, {
				success: false,
				errors: [{ code: 10006, message: "not found" }],
			});
		}
		return jsonResponse(200, { success: true, result: [] });
	}) as typeof fetch;
}

function fakeDescope(
	trustedDomains = "os.example.com",
	baseUrl = "https://auth.example.com",
	requests: RecordedRequest[] = [],
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, method: init?.method ?? "GET" });
		if (url.endsWith("/.well-known/openid-configuration")) {
			return jsonResponse(200, {
				issuer: `${baseUrl}/P3example`,
			});
		}
		return jsonResponse(200, {
			files: {
				"roles.json": {
					roles: ["owner", "admin", "member", "viewer"].map((name) => ({
						name,
						permissionNames: ["tedis:read"],
					})),
				},
				"project.json": { trustedDomains },
				"flows/sign-up-or-in/metadata.json": { disabled: false },
			},
		});
	}) as typeof fetch;
}

function interactiveManifest() {
	const manifest = structuredClone(developerInstallationManifest);
	Object.assign(manifest.workers[0]!.vars, {
		DESCOPE_PROJECT_ID: "P3example",
		OS_URL: "https://os.example.com",
		SESSION_BROKER_URL: "https://auth.example.com",
		DESCOPE_BASE_URL: "https://auth.example.com",
	});
	const broker = structuredClone(manifest.workers[0]!);
	broker.id = "session-broker";
	broker.sourceConfig = "apps/session-broker/wrangler.jsonc";
	broker.scriptName = { state: "resolved", value: "acme-session-broker" };
	broker.routes = [];
	broker.bindings = [];
	manifest.workers.push(broker);
	manifest.surfaces.push({
		id: "os",
		kind: "os",
		worker: "control-api",
		exposure: "authenticated",
	});
	return manifest;
}

describe("provisionCloudflareResources", () => {
	test("plan mode is strictly read-only and plans every API-creatable resource", async () => {
		const requests: RecordedRequest[] = [];
		const report = await provisionCloudflareResources({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({}, requests),
		});
		expect(report.mode).toBe("plan");
		expect(report.ok).toBe(true);
		expect(requests.every((request) => request.method === "GET")).toBe(true);
		const actions = Object.fromEntries(
			report.entries.map((entry) => [entry.id, entry.action]),
		);
		expect(actions).toEqual({
			"agent-state": "deploy-owned",
			"artifact-bucket": "planned-create",
			"browser-service": "capability",
			"cache-namespace": "planned-create",
			"event-queue": "planned-create",
			"graph-hyperdrive": "operator-required",
			"install-workflow": "deploy-owned",
			"memory-index": "planned-create",
			"os-assets": "deploy-owned",
			"primary-database": "planned-create",
			"runtime-service": "deploy-owned",
			"workers-ai": "capability",
			"workstation-container": "deploy-owned",
		});
	});

	test("apply mode creates missing resources and resolves coordinates", async () => {
		const requests: RecordedRequest[] = [];
		const report = await provisionCloudflareResources({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare({}, requests),
		});
		expect(report.ok).toBe(true);
		const created = report.entries
			.filter((entry) => entry.action === "created")
			.map((entry) => entry.id)
			.sort();
		expect(created).toEqual([
			"artifact-bucket",
			"cache-namespace",
			"event-queue",
			"memory-index",
			"primary-database",
		]);
		const posts = requests.filter((request) => request.method === "POST");
		expect(posts.length).toBe(5);
		// The developer example resolves its coordinates already, so nothing
		// needs resolution — but created ids are still reported per entry.
		expect(report.resolvedCoordinates).toEqual({});
	});

	test("refuses interactive apply before Cloudflare mutation without identity proof", async () => {
		const requests: RecordedRequest[] = [];
		await expect(
			provisionCloudflareResources({
				manifest: interactiveManifest(),
				apiToken: "test-token",
				mode: "apply",
				fetchImplementation: fakeCloudflare({}, requests),
			}),
		).rejects.toBeInstanceOf(IdentityReadinessRefusedError);
		expect(requests).toEqual([]);
	});

	test("records passing identity readiness before interactive apply", async () => {
		const report = await provisionCloudflareResources({
			manifest: interactiveManifest(),
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare(),
			identity: {
				managementKey: "management-secret",
				fetchImplementation: fakeDescope(),
			},
		});

		expect(report.ok).toBe(true);
		expect(report.identity?.ok).toBe(true);
		expect(JSON.stringify(report)).not.toContain("management-secret");
	});

	test("uses manifest identity coordinates despite runtime overrides and duplicate OS surfaces", async () => {
		const manifest = interactiveManifest();
		manifest.surfaces.push({
			id: "os-alias",
			kind: "os",
			worker: "control-api",
			exposure: "authenticated",
		});
		const requests: RecordedRequest[] = [];
		const identity = {
			managementKey: "management-secret",
			projectId: "wrong-project",
			osUrl: "https://wrong.example.com",
			baseUrl: "https://wrong.example.com",
			managementApiBaseUrl: "https://wrong.example.com",
			fetchImplementation: fakeDescope(
				"os.example.com",
				"https://auth.example.com",
				requests,
			),
		};
		const report = await provisionCloudflareResources({
			manifest,
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare(),
			identity,
		});
		expect(report.identity?.projectId).toBe("P3example");
		expect(report.identity?.surfaces[0]?.origin).toBe("https://os.example.com");
		expect(report.identity?.baseUrl).toBe("https://auth.example.com");
		expect(requests.map(({ url }) => url)).toEqual([
			"https://auth.example.com/P3example/.well-known/openid-configuration",
			"https://api.descope.com/v1/mgmt/project/export",
		]);
	});

	test("uses the manifest custom Descope base for discovery", async () => {
		const manifest = interactiveManifest();
		manifest.workers[0]!.vars.DESCOPE_BASE_URL = "https://identity.example.com";
		manifest.workers[0]!.vars.SESSION_BROKER_URL =
			"https://identity.example.com";
		manifest.workers[1]!.vars.DESCOPE_BASE_URL = "https://identity.example.com";
		manifest.workers[1]!.vars.SESSION_BROKER_URL =
			"https://identity.example.com";
		const requests: RecordedRequest[] = [];
		const report = await provisionCloudflareResources({
			manifest,
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare(),
			identity: {
				managementKey: "management-secret",
				fetchImplementation: fakeDescope(
					"os.example.com",
					"https://identity.example.com",
					requests,
				),
			},
		});
		expect(report.identity?.ok).toBe(true);
		expect(requests[0]?.url).toBe(
			"https://identity.example.com/P3example/.well-known/openid-configuration",
		);
	});

	test("refuses a split OS, broker, or Descope topology before any provider call", async () => {
		for (const mutate of [
			(manifest: ReturnType<typeof interactiveManifest>) => {
				manifest.workers[0]!.vars.SESSION_BROKER_URL =
					"https://other.example.com";
			},
			(manifest: ReturnType<typeof interactiveManifest>) => {
				manifest.workers[1]!.vars.OS_URL = "https://wrong.example.com";
			},
			(manifest: ReturnType<typeof interactiveManifest>) => {
				manifest.workers.pop();
			},
		]) {
			const manifest = interactiveManifest();
			mutate(manifest);
			const requests: RecordedRequest[] = [];
			await expect(
				provisionCloudflareResources({
					manifest,
					apiToken: "test-token",
					mode: "apply",
					fetchImplementation: fakeCloudflare({}, requests),
					identity: {
						managementKey: "management-secret",
						fetchImplementation: fakeDescope(
							"os.example.com",
							"https://auth.example.com",
							requests,
						),
					},
				}),
			).rejects.toThrow(/broker|session-broker/);
			expect(requests).toEqual([]);
		}
	});

	test("rejects invalid identity targets before any network request", async () => {
		const invalidOrigins = [
			"not-a-url",
			"http://os.example.com",
			"https://user:pass@os.example.com",
			"https://os.example.com/",
			"https://os.example.com/path",
			"https://os.example.com?x=1",
			"https://os.example.com#x",
			"https://os.example.com:443",
			"https://os.example.com:8443",
		];
		for (const key of [
			"OS_URL",
			"DESCOPE_PROJECT_ID",
			"DESCOPE_BASE_URL",
			"SESSION_BROKER_URL",
		]) {
			for (const value of [
				undefined,
				"",
				"   ",
				42,
				...(key === "DESCOPE_PROJECT_ID" ? [] : invalidOrigins),
			]) {
				const manifest = interactiveManifest();
				const vars = manifest.workers[0]!.vars as Record<string, unknown>;
				if (value === undefined) {
					vars[`VITE_${key}`] = vars[key];
					delete vars[key];
				} else vars[key] = value;
				const requests: RecordedRequest[] = [];
				await expect(
					provisionCloudflareResources({
						manifest,
						apiToken: "test-token",
						mode: "apply",
						fetchImplementation: fakeCloudflare({}, requests),
						identity: {
							managementKey: "management-secret",
							fetchImplementation: fakeDescope(
								"os.example.com",
								"https://auth.example.com",
								requests,
							),
						},
					}),
				).rejects.toThrow(`OS worker vars.${key}`);
				expect(requests).toEqual([]);
			}
		}
	});

	test("rejects multiple distinct OS workers before network requests", async () => {
		const manifest = interactiveManifest();
		const other = structuredClone(manifest.workers[0]!);
		other.id = "other-os";
		manifest.workers.push(other);
		manifest.surfaces.push({
			id: "other-os",
			kind: "os",
			worker: "other-os",
			exposure: "authenticated",
		});
		const requests: RecordedRequest[] = [];
		await expect(
			provisionCloudflareResources({
				manifest,
				apiToken: "test-token",
				mode: "apply",
				fetchImplementation: fakeCloudflare({}, requests),
				identity: {
					managementKey: "management-secret",
					fetchImplementation: fakeDescope(
						"os.example.com",
						"https://auth.example.com",
						requests,
					),
				},
			}),
		).rejects.toThrow("identity preflight requires exactly one OS worker");
		expect(requests).toEqual([]);
	});

	test("interactive plan still needs no identity configuration", async () => {
		const manifest = interactiveManifest();
		delete manifest.workers[0]!.vars.DESCOPE_PROJECT_ID;
		const requests: RecordedRequest[] = [];
		const report = await provisionCloudflareResources({
			manifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare({}, requests),
		});
		expect(report.ok).toBe(true);
		expect(report.identity).toBeUndefined();
		expect(requests.every(({ method }) => method === "GET")).toBe(true);
	});

	test("adopts existing resources instead of recreating them", async () => {
		const report = await provisionCloudflareResources({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare({
				"GET /d1/database?name=": () =>
					jsonResponse(200, {
						success: true,
						result: [{ name: "acme-developer", uuid: "existing-d1-uuid" }],
					}),
			}),
		});
		const database = report.entries.find(
			(entry) => entry.id === "primary-database",
		);
		expect(database?.action).toBe("adopted");
	});

	test("resolves unresolved coordinates from created resources", async () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			resources: Array<{ id: string; databaseId?: unknown }>;
		};
		const database = manifest.resources.find(
			(resource) => resource.id === "primary-database",
		);
		database!.databaseId = {
			state: "unresolved",
			key: "primary-database-id",
			reason: "created during provisioning",
		};
		const report = await provisionCloudflareResources({
			manifest,
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare(),
		});
		expect(report.resolvedCoordinates).toEqual({
			"primary-database-id": "created-d1-uuid",
		});
	});

	test("refuses before mutation when the preflight fails", async () => {
		const requests: RecordedRequest[] = [];
		await expect(
			provisionCloudflareResources({
				manifest: developerInstallationManifest,
				apiToken: "test-token",
				mode: "apply",
				fetchImplementation: fakeCloudflare(
					{
						"GET /d1/database?per_page=1": () =>
							jsonResponse(403, {
								success: false,
								errors: [{ code: 10000, message: "Authentication error" }],
							}),
					},
					requests,
				),
			}),
		).rejects.toBeInstanceOf(ProvisioningRefusedError);
		expect(requests.some((request) => request.method !== "GET")).toBe(false);
	});

	test("fails a required adopt resource that does not exist", async () => {
		const manifest = structuredClone(
			developerInstallationManifest,
		) as unknown as {
			resources: Array<{ id: string; provisioning?: string }>;
		};
		const database = manifest.resources.find(
			(resource) => resource.id === "primary-database",
		);
		database!.provisioning = "adopt";
		const report = await provisionCloudflareResources({
			manifest,
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare(),
		});
		expect(report.ok).toBe(false);
		const entry = report.entries.find(
			(candidate) => candidate.id === "primary-database",
		);
		expect(entry?.action).toBe("failed");
	});

	test("a failed optional resource does not block the report", async () => {
		const report = await provisionCloudflareResources({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			mode: "apply",
			fetchImplementation: fakeCloudflare({
				"POST /queues": () =>
					jsonResponse(500, {
						success: false,
						errors: [{ code: 7500, message: "internal error" }],
					}),
			}),
		});
		expect(report.ok).toBe(true);
		const entry = report.entries.find(
			(candidate) => candidate.id === "event-queue",
		);
		expect(entry?.action).toBe("failed");
		expect(entry?.requirement).toBe("optional");
	});
});

describe("executeD1Statements", () => {
	test("executes statements in order and stops at the first failure", async () => {
		const requests: RecordedRequest[] = [];
		const outcome = await executeD1Statements({
			accountId: ACCOUNT_ID,
			databaseId: "db-uuid",
			statements: ["CREATE TABLE a (id TEXT)", "BROKEN SQL", "never runs"],
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare(
				{
					"POST /d1/database/db-uuid/query": (request) =>
						(request.body as { sql?: string }).sql === "BROKEN SQL"
							? jsonResponse(400, {
									success: false,
									errors: [{ code: 7500, message: "syntax error" }],
								})
							: jsonResponse(200, { success: true, result: [] }),
				},
				requests,
			),
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.executed).toBe(1);
		expect(outcome.detail).toContain("7500");
		expect(requests.filter((request) => request.method === "POST").length).toBe(
			2,
		);
	});
});

describe("bootstrapPlan", () => {
	test("derives the sanitized seed plan from the manifest", () => {
		expect(bootstrapPlan(developerInstallationManifest)).toEqual({
			seed: "developer-example",
			inputs: developerInstallationManifest.bootstrap.inputs,
			databaseResourceIds: ["primary-database"],
		});
	});
});

describe("renderProvisionReport", () => {
	test("summarizes plan and failure outcomes", async () => {
		const planned = await provisionCloudflareResources({
			manifest: developerInstallationManifest,
			apiToken: "test-token",
			fetchImplementation: fakeCloudflare(),
		});
		const text = renderProvisionReport(planned);
		expect(text).toContain("PLANNED-CREATE");
		expect(text).toContain("PASS (plan)");
	});
});
