import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { createDbClient } from "@tedix/db/client";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "@tedix/db/schema/control-plane";
import {
	harnessEvalResults,
	harnessEvalRuns,
	harnessVersions,
	traceBundles,
} from "@tedix/db/schema/harness-versions";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	canAccessHarnessKernelSubject,
	canAccessHarnessTedi,
	componentsEqual,
	diffHarnessComponents,
	harnessContractRouter,
	harnessVersionBelongsToTedi,
	nextVersionString,
	serializeComponents,
	stampHarnessEvalRecorder,
} from "./harness";

const targetTedi = { id: "tedi-target", organizationId: "org-target" };
const context = (overrides: Partial<BaseContext>): BaseContext =>
	overrides as BaseContext;

function routeFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			runtimeProfiles,
			policyPacks,
			workspaceTemplateSets,
			tedis,
			harnessVersions,
			harnessEvalResults,
			harnessEvalRuns,
			traceBundles,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES
			('org-target', 'Target', 'target'), ('org-other', 'Other', 'other');
		INSERT INTO tedis (id, organization_id, name, slug) VALUES
			('tedi-target', 'org-target', 'Target', 'target'),
			('tedi-peer', 'org-target', 'Peer', 'peer'),
			('tedi-other', 'org-other', 'Other', 'other');
		INSERT INTO harness_versions (id, tedi_id, org_id, version, created_at) VALUES
			('hv-target', 'tedi-target', 'org-target', '1', '2026-09-22T00:00:00.000Z'),
			('hv-peer', 'tedi-peer', 'org-target', '1', '2026-09-22T00:00:00.000Z'),
			('hv-other', 'tedi-other', 'org-other', '1', '2026-09-22T00:00:00.000Z');
	`);
	const db = createDbClient(createD1Facade(sqlite)) as BaseContext["db"];
	const userContext = context({
		authType: "user",
		db,
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-target",
		url: new URL("https://api.test/rpc/harness"),
		user: {
			aud: "test",
			dct: "tenant",
			exp: 2,
			iat: 1,
			iss: "https://auth.test",
			permissions: ["tedis:read", "tedis:update"],
			roles: [],
			sub: "user-1",
		},
	});
	return { sqlite, db, userContext };
}

const evalResultInput = {
	id: "result-1",
	harnessVersionId: "hv-target",
	tediId: "tedi-target",
	orgId: "org-other",
	score: 1,
	gates: { success: true },
	passed: true,
	lane: "validation",
	taskSetId: "tasks-1",
	createdAt: "2026-09-22T00:00:00.000Z",
};

describe("serializeComponents / componentsEqual", () => {
	test("is order-independent over keys", () => {
		expect(serializeComponents({ a: "1", b: "2" })).toBe(
			serializeComponents({ b: "2", a: "1" }),
		);
		expect(componentsEqual({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
	});

	test("detects a changed value", () => {
		expect(componentsEqual({ a: "1" }, { a: "2" })).toBe(false);
	});

	test("detects an added/removed key", () => {
		expect(componentsEqual({ a: "1" }, { a: "1", b: "2" })).toBe(false);
		expect(componentsEqual({ a: "1", b: "2" }, { a: "1" })).toBe(false);
	});

	test("empty maps are equal", () => {
		expect(componentsEqual({}, {})).toBe(true);
	});
});

describe("diffHarnessComponents", () => {
	test("reports added, removed, and changed components in stable order", () => {
		expect(
			diffHarnessComponents(
				{
					model: "gpt-5",
					retrieval_policy: "v1",
					skill_policy: "v1",
				},
				{
					model: "gpt-5.6-terra",
					attention_router: "router-a",
					retrieval_policy: "v1",
				},
			),
		).toEqual([
			{
				component: "attention_router",
				base: null,
				candidate: "router-a",
				status: "added",
			},
			{
				component: "model",
				base: "gpt-5",
				candidate: "gpt-5.6-terra",
				status: "changed",
			},
			{
				component: "skill_policy",
				base: "v1",
				candidate: null,
				status: "removed",
			},
		]);
	});
});

describe("nextVersionString", () => {
	test("starts at 1 with no active version", () => {
		expect(nextVersionString(null)).toBe("1");
		expect(nextVersionString(undefined)).toBe("1");
	});

	test("increments a monotonic int", () => {
		expect(nextVersionString("1")).toBe("2");
		expect(nextVersionString("7")).toBe("8");
	});

	test("falls back to 1 for an unparseable (e.g. semver) version", () => {
		expect(nextVersionString("1.4.0")).toBe("2");
		expect(nextVersionString("v3")).toBe("1");
	});
});

describe("canAccessHarnessTedi", () => {
	test("allows the target tedi JWT only for its own ledger", () => {
		expect(
			canAccessHarnessTedi(context({ tediId: "tedi-target" }), targetTedi),
		).toBe(true);
		expect(
			canAccessHarnessTedi(
				context({
					apiKey: { id: "key-1", organizationId: "org-target", name: "key" },
					tediId: "other-tedi",
				}),
				targetTedi,
			),
		).toBe(false);
	});

	test("allows org-scoped scorers inside the target org", () => {
		expect(
			canAccessHarnessTedi(
				context({ organizationId: "org-target" }),
				targetTedi,
			),
		).toBe(true);
		expect(
			canAccessHarnessTedi(
				context({ organizationId: "org-other" }),
				targetTedi,
			),
		).toBe(false);
	});

	test("allows platform principals to record cross-org scorer evidence", () => {
		expect(
			canAccessHarnessTedi(
				context({
					apiKey: {
						id: "key-platform",
						organizationId: "org-platform",
						name: "platform harness scorer",
						scopes: ["platform:admin"],
					},
					authType: "apikey",
					organizationId: "org-platform",
				}),
				targetTedi,
			),
		).toBe(true);
	});
});

describe("harnessVersionBelongsToTedi", () => {
	test("binds versions to the exact tedi and canonical organization", () => {
		expect(
			harnessVersionBelongsToTedi(targetTedi, {
				tediId: "tedi-target",
				orgId: "org-target",
			}),
		).toBe(true);
		expect(
			harnessVersionBelongsToTedi(targetTedi, {
				tediId: "other-tedi",
				orgId: "org-target",
			}),
		).toBe(false);
		expect(
			harnessVersionBelongsToTedi(targetTedi, {
				tediId: "tedi-target",
				orgId: "org-other",
			}),
		).toBe(false);
	});

	test("accepts legacy null-org versions only through their canonical tedi", () => {
		expect(
			harnessVersionBelongsToTedi(targetTedi, {
				tediId: "tedi-target",
				orgId: null,
			}),
		).toBe(true);
		expect(
			harnessVersionBelongsToTedi(targetTedi, {
				tediId: "other-tedi",
				orgId: null,
			}),
		).toBe(false);
	});
});

describe("stampHarnessEvalRecorder", () => {
	test("overwrites caller provenance and trusts stable owner or runner principals", () => {
		expect(
			stampHarnessEvalRecorder(
				context({
					authType: "apikey",
					apiKey: {
						id: "key-1",
						organizationId: "org-target",
						name: "eval runner",
					},
				}),
				{
					recordedByPrincipalType: "user",
					recordedByPrincipalId: "forged-user",
					trustedForEarnedDelegation: false,
				},
			),
		).toMatchObject({
			recordedByPrincipalType: "api_key",
			recordedByPrincipalId: "key-1",
			trustedForEarnedDelegation: true,
		});
	});

	test("marks tedi and forwarded external-agent recorders as untrusted", () => {
		expect(
			stampHarnessEvalRecorder(
				context({
					authType: "service-binding",
					tediId: "tedi-target",
					serviceAccount: { clientId: "api-worker" },
				}),
				{ trustedForEarnedDelegation: true },
			),
		).toMatchObject({
			recordedByPrincipalType: "tedi",
			recordedByPrincipalId: "tedi-target",
			trustedForEarnedDelegation: false,
		});
		expect(
			stampHarnessEvalRecorder(
				context({
					authType: "service-binding",
					externalAgentPrincipalId: "agent-1",
					serviceAccount: { clientId: "mcp-worker" },
				}),
				undefined,
			),
		).toMatchObject({
			recordedByPrincipalType: "external_agent",
			recordedByPrincipalId: "agent-1",
			trustedForEarnedDelegation: false,
		});
	});
});

describe("canAccessHarnessKernelSubject", () => {
	test("allows org-scoped callers to read their own kernel subject", () => {
		expect(
			canAccessHarnessKernelSubject(context({ organizationId: "org-1" })),
		).toEqual({
			subjectKind: "kernel",
			subjectId: "kernel:org-1",
		});
	});

	test("rejects callers without organization context", () => {
		expect(canAccessHarnessKernelSubject(context({}))).toBeNull();
	});
});

describe("harness RPC route registration", () => {
	test("registers the kernel trace bundle readback endpoint", async () => {
		const handler = new RPCHandler({ harness: harnessContractRouter });
		const result = await handler.handle(
			new Request("https://api.test/rpc/harness/listKernelTraceBundles", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ json: { limit: 1 } }),
			}),
			{ prefix: "/rpc", context: {} },
		);

		expect(result.matched).toBe(true);
		expect(result.response?.status).not.toBe(404);
	});

	test.each(["readKernelTraceBundleFile", "deleteKernelTraceBundle"])(
		"registers and protects the platform trace endpoint %s",
		async (route) => {
			const handler = new RPCHandler({ harness: harnessContractRouter });
			const result = await handler.handle(
				new Request(`https://api.test/rpc/harness/${route}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						json: {
							organizationId: "0f0f0f0f-0000-4000-8000-000000000001",
							runId: "run-1",
							fileName: "manifest.json",
							reason: "retention expiry",
						},
					}),
				}),
				{ prefix: "/rpc", context: {} },
			);

			expect(result.matched).toBe(true);
			expect(result.response?.status).not.toBe(404);
			expect(result.response?.status).toBeGreaterThanOrEqual(400);
		},
	);
});

describe("harness RPC ownership effects", () => {
	test.each([
		"recordEvalResult",
		"recordEvalRun",
		"recordTraceBundle",
		"getEvalSummaryForVersion",
	] as const)(
		"rejects a same-org version belonging to another tedi in %s",
		async (route) => {
			const { userContext } = routeFixture();
			const client = createRouterClient(harnessContractRouter, {
				context: userContext,
			});
			const inputs = {
				recordEvalResult: { ...evalResultInput, harnessVersionId: "hv-peer" },
				recordEvalRun: {
					id: "run-1",
					harnessVersionId: "hv-peer",
					tediId: "tedi-target",
					lane: "validation",
					taskSetId: "tasks-1",
					total: 1,
					passed: 1,
					failed: 0,
					meanScore: 1,
					eligible: true,
					createdAt: "2026-09-22T00:00:00.000Z",
				},
				recordTraceBundle: {
					id: "bundle-1",
					tediId: "tedi-target",
					runId: "run-1",
					harnessVersionId: "hv-peer",
					createdAt: "2026-09-22T00:00:00.000Z",
				},
				getEvalSummaryForVersion: {
					tediId: "tedi-target",
					harnessVersionId: "hv-peer",
				},
			};
			await expect(
				(client[route] as (input: never) => Promise<unknown>)(
					inputs[route] as never,
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	test("forces the canonical organization on an accepted eval result", async () => {
		const { userContext, sqlite } = routeFixture();
		const client = createRouterClient(harnessContractRouter, {
			context: userContext,
		});
		const response = await client.recordEvalResult(evalResultInput);
		expect(response.result.orgId).toBe("org-target");
		expect(
			sqlite.prepare("SELECT org_id FROM harness_eval_results").get(),
		).toEqual({ org_id: "org-target" });
	});

	test("allows a platform principal to write a matching cross-org tuple", async () => {
		const { db, sqlite } = routeFixture();
		const client = createRouterClient(harnessContractRouter, {
			context: context({
				authType: "apikey",
				db,
				env: { ENVIRONMENT: "test" } as CloudflareEnv,
				headers: new Headers(),
				organizationId: "org-target",
				url: new URL("https://api.test/rpc/harness"),
				apiKey: {
					id: "platform-key",
					name: "platform",
					organizationId: "org-target",
					scopes: ["platform:admin", "tedis:write"],
				},
			}),
		});
		await client.recordEvalResult({
			...evalResultInput,
			id: "result-other",
			tediId: "tedi-other",
			harnessVersionId: "hv-other",
		});
		expect(
			sqlite
				.prepare(
					"SELECT org_id FROM harness_eval_results WHERE id = 'result-other'",
				)
				.get(),
		).toEqual({ org_id: "org-other" });
	});

	test("does not stamp an unpersisted score from a conflicting eval-run retry", async () => {
		const { userContext, sqlite } = routeFixture();
		const client = createRouterClient(harnessContractRouter, {
			context: userContext,
		});
		const run = {
			id: "run-retry",
			harnessVersionId: "hv-target",
			tediId: "tedi-target",
			lane: "validation",
			taskSetId: "tasks-1",
			total: 1,
			passed: 1,
			failed: 0,
			meanScore: 1,
			eligible: true,
			createdAt: "2026-09-22T00:00:00.000Z",
		};
		await client.recordEvalRun(run);
		await expect(
			client.recordEvalRun({ ...run, meanScore: 0.01 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const row = sqlite
			.prepare(
				"SELECT mean_score, metadata FROM harness_eval_runs WHERE id = 'run-retry'",
			)
			.get() as { mean_score: number; metadata: string };
		expect(row.mean_score).toBe(1);
		const version = sqlite
			.prepare("SELECT metadata FROM harness_versions WHERE id = 'hv-target'")
			.get() as { metadata: string };
		expect(JSON.parse(version.metadata)).toMatchObject({
			latestEval: { meanScore: 1 },
		});
	});

	test("rejects a trace id collision without changing the existing peer bundle", async () => {
		const { userContext, sqlite } = routeFixture();
		const client = createRouterClient(harnessContractRouter, {
			context: userContext,
		});
		await client.recordTraceBundle({
			id: "shared-bundle",
			tediId: "tedi-peer",
			runId: "peer-run",
			harnessVersionId: "hv-peer",
			artifactIds: ["peer-artifact"],
			createdAt: "2026-09-22T00:00:00.000Z",
		});
		await expect(
			client.recordTraceBundle({
				id: "shared-bundle",
				tediId: "tedi-target",
				runId: "target-run",
				harnessVersionId: "hv-target",
				artifactIds: ["target-artifact"],
				createdAt: "2026-09-22T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite
				.prepare(
					"SELECT tedi_id, artifact_ids FROM trace_bundles WHERE id = 'shared-bundle'",
				)
				.get(),
		).toEqual({ tedi_id: "tedi-peer", artifact_ids: '["peer-artifact"]' });
	});
});
