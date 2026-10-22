/**
 * The tedi runtime's native `web_search` tool reaches `webSearch.search` over
 * the trusted service binding, delegating exactly
 * `TEDI_RUNTIME_SERVICE_BINDING_SCOPES`. These tests build that context with
 * the real list (imported, never copied), so the endpoint's required scope and
 * the runtime's delegated list cannot drift apart again (every live search
 * 403'd when the route asked for `connections.execute`).
 */

import { createRouterClient } from "@orpc/server";
import { WEB_SEARCH_EXECUTE_SCOPE } from "@tedix/api-contract/schemas/web-search";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { tediCallCosts, tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { TEDI_RUNTIME_SERVICE_BINDING_SCOPES } from "../../../../tedi-runtime/src/platform-client-factory";
import type { BaseContext } from "../orpc";
import { webSearchContractRouter } from "./web-search";

const ORG_ID = "00000000-0000-4000-8000-000000000201";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000202";
const TEDI_ID = "tedi-researcher";
const OPTED_OUT_TEDI_ID = "tedi-opted-out";
const CEILING_TEDI_ID = "tedi-ceiling";
const RETIRED_TEDI_ID = "tedi-retired";
const OTHER_ORG_TEDI_ID = "tedi-elsewhere";

function fixture(input?: { organizationWebSearch?: unknown }) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(organizations, tedis, tediCallCosts));
	const insertOrg = sqlite.prepare(
		"INSERT INTO organizations (id,name,slug,metadata) VALUES (?,?,?,?)",
	);
	insertOrg.run(
		ORG_ID,
		"Acme",
		"acme",
		JSON.stringify({
			webSearch:
				input && "organizationWebSearch" in input
					? input.organizationWebSearch
					: { enabled: true, maxResults: 3 },
		}),
	);
	insertOrg.run(OTHER_ORG_ID, "Elsewhere", "elsewhere", JSON.stringify({}));
	const insertTedi = sqlite.prepare(
		"INSERT INTO tedis (id,organization_id,name,slug,status,mcp_capability_profile,tool_policy,retired_at) VALUES (?,?,?,?,'active','standard',?,?)",
	);
	insertTedi.run(TEDI_ID, ORG_ID, "Researcher", "researcher", null, null);
	insertTedi.run(
		OPTED_OUT_TEDI_ID,
		ORG_ID,
		"Opted out",
		"opted-out",
		JSON.stringify({ webSearch: "off" }),
		null,
	);
	insertTedi.run(
		CEILING_TEDI_ID,
		ORG_ID,
		"Ceiling",
		"ceiling",
		JSON.stringify({ runtimeTools: ["read_memory"] }),
		null,
	);
	insertTedi.run(
		RETIRED_TEDI_ID,
		ORG_ID,
		"Retired",
		"retired",
		null,
		"2026-10-01T00:00:00.000Z",
	);
	insertTedi.run(
		OTHER_ORG_TEDI_ID,
		OTHER_ORG_ID,
		"Elsewhere",
		"elsewhere",
		null,
		null,
	);

	const searches: Array<{ gatewayId: string; query: string; limit: number }> =
		[];
	const facade = createD1Facade(sqlite);
	const base = {
		db: createDbClient(facade),
		env: {
			ENVIRONMENT: "test",
			DB: facade,
			AI_GATEWAY_LLM_ID: "gateway-test",
			AI: {
				websearch: async (request: {
					gatewayId: string;
					query: string;
					limit: number;
				}) => {
					searches.push(request);
					return new Response(
						JSON.stringify({
							items: [
								{
									title: "Bun 1.3 released",
									url: "https://bun.sh/blog/bun-v1.3",
									description: "Release notes",
								},
							],
						}),
						{ status: 200, headers: { "cf-aig-log-id": "log-1" } },
					);
				},
			},
		} as unknown as CloudflareEnv,
		url: new URL("https://api.tedix.test/rpc/web-search"),
	};
	/** Exactly what `HttpPlatformClient` sends over the runtime service binding. */
	const runtimeClient = (
		tediId: string | null,
		options?: { organizationId?: string; scopes?: readonly string[] },
	) =>
		createRouterClient(webSearchContractRouter, {
			context: {
				...base,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": options?.organizationId ?? ORG_ID,
					...(tediId ? { "X-Tedix-Tedi-Id": tediId } : {}),
					"X-Tedix-Caller": "brain-bridge",
					"X-Tedix-Caller-Source": "http-platform-client",
					"X-Tedix-Tedi-Scopes": (
						options?.scopes ?? TEDI_RUNTIME_SERVICE_BINDING_SCOPES
					).join(" "),
				}),
			} as BaseContext,
		});
	const costRows = () =>
		sqlite
			.prepare(
				"SELECT org_id AS orgId, tedi_id AS tediId, run_id AS runId, model, gateway_log_id AS gatewayLogId FROM tedi_call_costs",
			)
			.all();
	return { base, runtimeClient, searches, costRows };
}

describe("webSearch.search over the tedi runtime service binding", () => {
	it("delegates the dedicated scope, and nothing wider", () => {
		expect(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).toContain(
			WEB_SEARCH_EXECUTE_SCOPE,
		);
		expect(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).not.toContain(
			"connections.execute",
		);
		expect(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).not.toContain("*");
	});

	it("searches for the calling tedi in its own organization and records the cost receipt", async () => {
		const { runtimeClient, searches, costRows } = fixture();
		const output = await runtimeClient(TEDI_ID).search({
			query: "latest stable Bun version",
			runId: "run-1",
		});
		expect(output).toMatchObject({
			status: "ok",
			trust: "untrusted",
			results: [{ url: "https://bun.sh/blog/bun-v1.3" }],
			citations: ["[1. bun.sh](https://bun.sh/blog/bun-v1.3)"],
		});
		expect(searches).toEqual([
			{
				gatewayId: "gateway-test",
				query: "latest stable Bun version",
				limit: 3,
			},
		]);
		expect(costRows()).toEqual([
			{
				orgId: ORG_ID,
				tediId: TEDI_ID,
				runId: "run-1",
				model: "web-search",
				gatewayLogId: "log-1",
			},
		]);
	});

	it("caps the limit at the organization's ceiling", async () => {
		const { runtimeClient, searches } = fixture();
		await runtimeClient(TEDI_ID).search({ query: "bun", limit: 10 });
		expect(searches[0]?.limit).toBe(3);
	});

	it.each([
		["the organization has not enabled it", undefined, TEDI_ID],
		["the organization switched it off", { enabled: false }, TEDI_ID],
		["the tedi opted out", { enabled: true }, OPTED_OUT_TEDI_ID],
		[
			"the tedi's runtime-tool ceiling omits web_search",
			{ enabled: true },
			CEILING_TEDI_ID,
		],
	])(
		"answers disabled when %s",
		async (_case, organizationWebSearch, tediId) => {
			const { runtimeClient, searches, costRows } = fixture({
				organizationWebSearch,
			});
			await expect(
				runtimeClient(tediId).search({ query: "bun" }),
			).resolves.toEqual({
				status: "disabled",
				message: "Web search is not enabled for this tedi.",
			});
			expect(searches).toEqual([]);
			expect(costRows()).toEqual([]);
		},
	);

	it("refuses a tedi of another organization and a retired tedi", async () => {
		const { runtimeClient, searches } = fixture();
		// The runtime names the tedi's own org; a tedi row elsewhere is not it.
		await expect(
			runtimeClient(OTHER_ORG_TEDI_ID).search({ query: "bun" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Access denied to this tedi",
		});
		// Naming another org does not reach that org's switch either.
		await expect(
			runtimeClient(TEDI_ID, { organizationId: OTHER_ORG_ID }).search({
				query: "bun",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			runtimeClient(RETIRED_TEDI_ID).search({ query: "bun" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Access denied to this tedi",
		});
		expect(searches).toEqual([]);
	});

	it("refuses a service binding without the dedicated scope, even with every other runtime scope", async () => {
		const { runtimeClient, searches } = fixture();
		await expect(
			runtimeClient(TEDI_ID, {
				scopes: TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
					(scope) => scope !== WEB_SEARCH_EXECUTE_SCOPE,
				),
			}).search({ query: "bun" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: `Delegated service-binding scope '${WEB_SEARCH_EXECUTE_SCOPE}' required`,
		});
		await expect(
			runtimeClient(TEDI_ID, { scopes: ["connections.execute"] }).search({
				query: "bun",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(searches).toEqual([]);
	});

	it("refuses a service binding that carries no tedi identity", async () => {
		const { runtimeClient, searches } = fixture();
		await expect(
			runtimeClient(null).search({ query: "bun" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Web search runs for a tedi credential only",
		});
		expect(searches).toEqual([]);
	});

	it("refuses people and API keys: there is no human or key path to the search", async () => {
		const { base, searches } = fixture();
		const member = createRouterClient(webSearchContractRouter, {
			context: {
				...base,
				authType: "user",
				headers: new Headers(),
				organizationId: ORG_ID,
				userId: "member-user",
				userRole: "member",
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: [],
					roles: [],
					sub: "member-subject",
				},
			} as BaseContext,
		});
		await expect(member.search({ query: "bun" })).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Web search runs for a tedi credential only",
		});
		const wildcardKey = createRouterClient(webSearchContractRouter, {
			context: {
				...base,
				authType: "apikey",
				headers: new Headers(),
				organizationId: ORG_ID,
				apiKey: {
					id: "key-1",
					name: "wildcard",
					organizationId: ORG_ID,
					scopes: ["*"],
				},
			} as BaseContext,
		});
		await expect(wildcardKey.search({ query: "bun" })).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Web search runs for a tedi credential only",
		});
		expect(searches).toEqual([]);
	});
});
