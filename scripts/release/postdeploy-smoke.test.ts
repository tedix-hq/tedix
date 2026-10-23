import { describe, expect, test } from "bun:test";
import { TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE } from "../../packages/auth/src/workload-identity";
import {
	checkBootstrap,
	checkGateway,
	checkHealth,
	exchangeWorkloadCredential,
	failureClass,
	githubWorkloadAssertion,
	healthProblem,
	parseArgs,
	sessionExchangeBody,
	type SmokeClient,
	WORK_LIST_CALLABLE,
	WORKLOAD_AUDIENCE,
} from "./postdeploy-smoke";

const ORG = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
const MCP_URL = "https://example-gateway.example.test/mcp";

const freshness = {
	source: "manual",
	sourceRef: "@tedix/api-contract/schemas/tools:Example",
	sourceHash: "abc123",
	syncedAt: "2026-10-01T00:00:00.000Z",
};

function descriptor(name: string, endpoint: string) {
	return {
		name,
		toolRowId: `${name}-row`,
		endpoint,
		eligible: true,
		authorized: true,
		schemaFreshness: freshness,
	};
}

function info(overrides: Record<string, unknown> = {}) {
	return {
		name: "Example gateway",
		nativeContext: {
			version: 1,
			surface: "mcp-gateway",
			appId: "app-1",
			appSlug: "example",
			organizationId: ORG,
			actor: { authType: "external_agent" },
			nativeTransportAvailable: true,
		},
		nativeCatalog: {
			status: "usable",
			search: descriptor("search_native_tools", "catalog/search"),
			describe: descriptor("get_native_tool_schema", "catalog/describe"),
		},
		...overrides,
	};
}

const workNative = descriptor(
	"example__list_work_item_cli_rows",
	"workItems/listCliProjection",
);

function healthyClient(overrides: Partial<SmokeClient> = {}): SmokeClient {
	return {
		async callTool(name) {
			if (name === "get_info") return info();
			if (name === "search_native_tools")
				return {
					results: [
						{
							callable: WORK_LIST_CALLABLE,
							authorized: true,
							native: workNative,
						},
					],
				};
			if (name === "get_native_tool_schema")
				return {
					callable: WORK_LIST_CALLABLE,
					authorized: true,
					aliasOf: null,
					native: workNative,
					parameters: { type: "object" },
				};
			throw new Error(`unexpected tool ${name}`);
		},
		async runCode() {
			return [{ callable: WORK_LIST_CALLABLE }];
		},
		async listWork() {
			return {
				view: "board",
				data: [{ id: "x" }],
				pagination: { limit: 1, offset: 0, total: 3, hasMore: true },
			};
		},
		...overrides,
	};
}

describe("parseArgs", () => {
	test("collects repeated health URLs and gateway options", () => {
		const options = parseArgs([
			"--health",
			"https://a.example.test/health",
			"--health",
			"https://b.example.test/health",
			"--mcp-url",
			MCP_URL,
			"--organization",
			ORG,
			"--principal",
			PRINCIPAL,
		]);
		expect(options.health).toHaveLength(2);
		expect(options.mcpUrl).toBe(MCP_URL);
		expect(options.sessionKey).toBe("github-actions:tedix-postdeploy-smoke");
	});

	test("refuses a gateway without an organization and an empty run", () => {
		expect(() => parseArgs(["--mcp-url", MCP_URL])).toThrow("--organization");
		expect(() => parseArgs([])).toThrow("Nothing to check");
		expect(() => parseArgs(["--health"])).toThrow("needs a value");
		expect(() => parseArgs(["--nope", "x"])).toThrow("Unknown option");
	});
});

describe("health", () => {
	test("needs 200 and an ok status when one is reported", () => {
		expect(healthProblem(200, '{"status":"ok"}')).toBeNull();
		expect(healthProblem(200, "plain text")).toBeNull();
		expect(healthProblem(503, "")).toBe("HTTP 503");
		expect(healthProblem(200, '{"status":"degraded"}')).toBe(
			'status "degraded"',
		);
	});

	test("reports each URL separately", async () => {
		const results = await checkHealth(
			["https://up.example.test/health", "https://down.example.test/health"],
			async (url) =>
				String(url).includes("down")
					? new Response("", { status: 502 })
					: Response.json({ status: "ok" }),
		);
		expect(results.map((r) => [r.ok, r.detail])).toEqual([
			[true, "ok"],
			[false, "HTTP 502"],
		]);
	});
});

describe("checkBootstrap", () => {
	test("accepts a usable catalog for the expected organization", () => {
		expect(checkBootstrap(info(), ORG)).toEqual({
			search: "search_native_tools",
			describe: "get_native_tool_schema",
		});
	});

	test("fails the way the CLI fails when the catalog is unavailable", () => {
		const unavailable = info({
			nativeCatalog: { status: "unavailable", search: null, describe: null },
		});
		expect(() => checkBootstrap(unavailable, ORG)).toThrow(
			"nativeCatalog is unavailable",
		);
	});

	test("fails without nativeContext or for another organization", () => {
		expect(() =>
			checkBootstrap(
				info({
					nativeContext: null,
					nativeCatalog: {
						status: "unavailable",
						search: null,
						describe: null,
					},
				}),
				ORG,
			),
		).toThrow("nativeContext is missing");
		expect(() =>
			checkBootstrap(info(), "00000000-0000-4000-8000-000000000009"),
		).toThrow("expected 00000000-0000-4000-8000-000000000009");
	});

	test("fails on a descriptor without schema provenance", () => {
		const search = {
			...descriptor("search_native_tools", "catalog/search"),
			schemaFreshness: { ...freshness, sourceHash: null },
		};
		const value = info();
		(value.nativeCatalog as Record<string, unknown>).search = search;
		expect(() => checkBootstrap(value, ORG)).toThrow("no schema provenance");
	});
});

describe("checkGateway", () => {
	test("passes every check on a healthy gateway", async () => {
		const results = await checkGateway(healthyClient(), ORG);
		expect(results.map((r) => [r.name, r.ok])).toEqual([
			["get_info native bootstrap", true],
			["native catalog search", true],
			["native catalog describe", true],
			["work list", true],
			["code mode discover.search", true],
		]);
		expect(results[3]?.detail).toBe("1 row(s) of 3");
	});

	test("an unavailable catalog fails bootstrap and the Work list", async () => {
		const results = await checkGateway(
			healthyClient({
				async callTool(name) {
					if (name === "get_info")
						return info({
							nativeCatalog: {
								status: "unavailable",
								search: null,
								describe: null,
							},
						});
					throw new Error(`unexpected tool ${name}`);
				},
				async listWork() {
					throw new Error("Work native catalog unavailable");
				},
			}),
			ORG,
		);
		expect(results.map((r) => [r.name, r.ok])).toEqual([
			["get_info native bootstrap", false],
			["work list", false],
			["code mode discover.search", true],
		]);
	});

	test("a search row the caller may not use fails search and skips describe", async () => {
		const client = healthyClient();
		const results = await checkGateway(
			{
				...client,
				async callTool(name, args) {
					if (name === "search_native_tools")
						return {
							results: [{ callable: WORK_LIST_CALLABLE, authorized: false }],
						};
					return client.callTool(name, args);
				},
			},
			ORG,
		);
		expect(results.find((r) => r.name === "native catalog search")?.ok).toBe(
			false,
		);
		expect(results.some((r) => r.name === "native catalog describe")).toBe(
			false,
		);
	});

	test("an empty discover.search fails", async () => {
		const results = await checkGateway(
			healthyClient({ runCode: async () => [] }),
			ORG,
		);
		expect(results.at(-1)).toMatchObject({
			ok: false,
			detail: "discover.search returned no tools",
		});
	});
});

describe("workload credential", () => {
	test("requests the Tedix workload audience", async () => {
		let requested = "";
		const assertion = await githubWorkloadAssertion(
			{
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.test/token?x=1",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
			},
			async (url) => {
				requested = String(url);
				return Response.json({ value: "assertion" });
			},
		);
		expect(assertion).toBe("assertion");
		expect(WORKLOAD_AUDIENCE).toBe(TEDIX_EXTERNAL_AGENT_WORKLOAD_AUDIENCE);
		expect(new URL(requested).searchParams.get("audience")).toBe(
			WORKLOAD_AUDIENCE,
		);
	});

	test("explains a missing id-token permission", async () => {
		await expect(githubWorkloadAssertion({})).rejects.toThrow(
			"id-token: write",
		);
	});

	test("exchanges at the gateway origin with a stable session tuple", async () => {
		const body = sessionExchangeBody({
			organizationId: ORG,
			principalId: PRINCIPAL,
			sessionKey: "github-actions:smoke",
			mcpUrl: MCP_URL,
		});
		expect(body.scopes).toEqual(["mcp:work.read", "mcp:observe.read"]);
		let target = "";
		let authorization = "";
		const token = await exchangeWorkloadCredential(
			"assertion",
			body,
			async (url, init) => {
				target = String(url);
				authorization = new Headers(init?.headers).get("Authorization") ?? "";
				return Response.json(
					{ credential: { accessToken: "gateway-token" } },
					{ status: 201 },
				);
			},
		);
		expect(token).toBe("gateway-token");
		expect(target).toBe(
			"https://example-gateway.example.test/external-agents/session",
		);
		expect(authorization).toBe("Bearer assertion");
	});

	test("reports the rejection code, never the payload", async () => {
		await expect(
			exchangeWorkloadCredential(
				"assertion",
				sessionExchangeBody({
					organizationId: ORG,
					principalId: PRINCIPAL,
					sessionKey: "github-actions:smoke",
					mcpUrl: MCP_URL,
				}),
				async () =>
					Response.json({ code: "principal_not_found" }, { status: 404 }),
			),
		).rejects.toThrow("HTTP 404 (principal_not_found)");
	});
});

describe("failure classification", () => {
	test.each([
		"HTTP 401",
		"HTTP 403",
		"HTTP 429",
		"fetch failed",
		"getaddrinfo ENOTFOUND",
		"TLS certificate error",
		"The operation timed out",
		"ECONNRESET",
	])("classifies %s as infrastructure", async (detail) => {
		const results = await checkGateway(
			healthyClient({
				listWork: async () => {
					throw new Error(detail);
				},
			}),
			ORG,
		);
		expect(results.find((r) => r.name === "work list")?.failureClass).toBe(
			"infra",
		);
	});
	test.each([
		"HTTP 500",
		"HTTP 502",
		"application error",
		"native catalog unavailable",
	])("classifies %s as product", async (detail) => {
		const results = await checkGateway(
			healthyClient({
				listWork: async () => {
					throw new Error(detail);
				},
			}),
			ORG,
		);
		expect(results.find((r) => r.name === "work list")?.failureClass).toBe(
			"product",
		);
	});
	test("health SHA mismatch is a product fault and successful checks have no failure class", async () => {
		const url = "https://example.test/health";
		const results = await checkHealth(
			[url],
			async () => Response.json({ status: "ok", deployedSha: "a".repeat(40) }),
			{ [url]: "b".repeat(40) },
		);
		expect(results[0]).toMatchObject({ ok: false, failureClass: "product" });
		expect(
			healthProblem(
				200,
				JSON.stringify({ deployedSha: "a".repeat(40) }),
				"a".repeat(40),
			),
		).toBeNull();
		expect(
			(await checkHealth([url], async () => Response.json({ status: "ok" })))[0]
				?.failureClass,
		).toBeNull();
	});
});

test("credential 401, structured status and nested network causes remain infrastructure", () => {
	expect(
		failureClass(
			new Error(
				"Workload credential exchange failed: HTTP 401 (invalid_token)",
			),
			"workload credential",
		),
	).toBe("infra");
	expect(failureClass({ status: 403 })).toBe("infra");
	expect(
		failureClass(
			new Error("request failed", {
				cause: new Error("getaddrinfo ENOTFOUND"),
			}),
		),
	).toBe("infra");
	expect(
		failureClass(
			new Error("Unable to connect. Is the computer able to access the url?"),
		),
	).toBe("infra");
	expect(
		failureClass(
			new Error("Workload credential exchange failed: HTTP 503"),
			"workload credential",
		),
	).toBe("product");
});

test("per-surface SHA arguments and custom health fields are checked", () => {
	const url = "https://example.test/health",
		sha = "a".repeat(40);
	const options = parseArgs([
		"--health",
		url,
		"--health-sha",
		`${url}=${sha}`,
		"--health-sha-field",
		`${url}=runtimeDeployedSha`,
	]);
	expect(options.expectedShas).toEqual({ [url]: sha });
	expect(options.shaFields).toEqual({ [url]: "runtimeDeployedSha" });
	expect(
		healthProblem(
			200,
			JSON.stringify({ runtimeDeployedSha: sha, deployedSha: "other" }),
			sha,
			"runtimeDeployedSha",
		),
	).toBeNull();
	expect(() => parseArgs(["--health", url, "--health-sha", "bad"])).toThrow(
		"URL=full-sha",
	);
	expect(() =>
		parseArgs(["--health", url, "--health-sha-field", "bad"]),
	).toThrow("URL=field");
});

test.each([
	["--health-sha", "a".repeat(40)],
	["--health-sha-field", "runtimeDeployedSha"],
])("rejects %s for a URL that is not checked", (flag, value) => {
	const url = "https://unchecked.example.test/health";
	for (const checks of [
		["--health", "https://example.test/health"],
		["--mcp-url", MCP_URL, "--organization", ORG],
	]) {
		expect(() => parseArgs([...checks, flag, `${url}=${value}`])).toThrow(
			`${flag} URL is not in --health: ${url}`,
		);
	}
});

test("accepts SHA options before their matching health URL", () => {
	const url = "https://example.test/health";
	const sha = "a".repeat(40);
	const options = parseArgs([
		"--health-sha",
		`${url}=${sha}`,
		"--health-sha-field",
		`${url}=runtimeDeployedSha`,
		"--health",
		url,
	]);
	expect(options.expectedShas).toEqual({ [url]: sha });
	expect(options.shaFields).toEqual({ [url]: "runtimeDeployedSha" });
});
