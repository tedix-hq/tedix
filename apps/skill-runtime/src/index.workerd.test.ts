import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

// The runtime exposes a module Worker's default object handler here, while the
// generated loopback type only enumerates RPC-compatible named exports.
const worker = (exports as typeof exports & { default: Fetcher }).default;

describe("skill runtime Worker boundary", () => {
	it("serves health through the real workerd entry", async () => {
		const response = await worker.fetch(
			"https://skill-runtime.tedix.dev/health",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			service: "skill-runtime",
			env: "development",
			// Builds stamp GIT_SHA, else GITHUB_SHA (set on Actions), else "unknown".
			deployedSha: expect.stringMatching(/^(?:unknown|[0-9a-f]{40})$/),
		});
	});

	it("rejects unauthenticated run admission before touching storage", async () => {
		const response = await worker.fetch("https://skill-runtime.tedix.dev/run", {
			method: "POST",
			body: "{}",
		});

		expect(response.status).toBe(401);
	});

	it("binds the Workflow, loader, rate limiter, and version metadata", () => {
		const bindings = env as unknown as Record<string, unknown>;
		expect(typeof (bindings.WORKFLOWS as Workflow | undefined)?.create).toBe(
			"function",
		);
		expect(bindings.LOADER).toBeDefined();
		expect(bindings.RUN_RATE_LIMITER).toBeDefined();
		expect(bindings.WORKER_VERSION).toBeDefined();
	});
});

import {
	loadSkillRuntime,
	type LoadSkillRuntimeInput,
	type SkillRuntimeEnv,
	type SkillRuntimeExportFactories,
} from "./runner";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";

// Local test persistence for the production ArtifactBridge called by dispatch.
beforeAll(async () => {
	await (env as unknown as { DB: D1Database }).DB.exec(
		`CREATE TABLE IF NOT EXISTS skill_run_artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/json', size_bytes INTEGER NOT NULL DEFAULT 0, content_inline TEXT, content_r2_key TEXT, sha256 TEXT, attempt INTEGER NOT NULL DEFAULT 1, outcome TEXT NOT NULL DEFAULT 'success', created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(run_id,path))`,
	);
});
function skillInput(network: boolean): LoadSkillRuntimeInput {
	const hash = crypto.randomUUID();
	return {
		skillId: "isolation-skill",
		tediId: "isolation-tedi",
		aggregateMcpSlug: "tedix",
		orgId: "isolation-org",
		runId: hash,
		executionEpoch: 0,
		admittedAt: new Date().toISOString(),
		loaderConfigHash: hash,
		code: `export default { async run(_event, _step, env) { let denied = false; try { await fetch("https://example.com/ambient-forbidden"); } catch { denied = true; } return { keys: Object.keys(env).sort(), denied, secret: env.PLATFORM_SERVICE_TOKEN ?? null, apiKey: env.GEMINI_API_KEY ?? null }; } };`,
		manifest: parseCapabilityManifest(
			`---\ncapabilities:\n  network: ${network}\n---`,
		),
		provenance: {
			source: {
				workflowSha256: hash,
				skillDocSha256: hash,
				skillRevision: 1,
				skillSlug: "isolation-proof",
			},
			runtime: {
				workerVersionId: "test",
				workerVersionTag: "test",
				workerVersionTimestamp: "test",
				executionCompatibilityHash: hash,
				dispatchShimVersion: "test",
				compatibilityDate: "2026-06-11",
				dynamicWorkflowsVersion: "0.1.1",
				loaderConfigHash: hash,
				tenantCpuMs: 60000,
				tenantSubRequests: 1000,
			},
		},
	};
}

describe("skill production Loader isolation", () => {
	for (const network of [false, true])
		it(`preserves governed network=${network} and hides platform credentials in a native loaded Worker`, async () => {
			const native = (env as unknown as { LOADER: WorkerLoader }).LOADER;
			let captured: WorkerLoaderWorkerCode | undefined;
			let outbound: Fetcher | undefined;
			const nativeFactories = exports as unknown as SkillRuntimeExportFactories;
			const factories: SkillRuntimeExportFactories = {
				McpBridge: (opts) => nativeFactories.McpBridge(opts),
				ArtifactBridge: (opts) => nativeFactories.ArtifactBridge(opts),
				EvidenceBridge: (opts) => nativeFactories.EvidenceBridge(opts),
				ReasonBridge: (opts) => nativeFactories.ReasonBridge(opts),
				RationaleBridge: (opts) => nativeFactories.RationaleBridge(opts),
				OutboundProxy: (opts) => {
					outbound = nativeFactories.OutboundProxy(opts);
					return outbound;
				},
			};
			const loader: WorkerLoader = {
				load: (code) => native.load(code),
				get: (name, getCode) =>
					native.get(name, async () => {
						captured = await getCode();
						return captured;
					}),
			};
			const input = skillInput(network);
			const runner = loadSkillRuntime(
				{
					LOADER: loader,
					PLATFORM_SERVICE_TOKEN: "host-only-canary",
					GEMINI_API_KEY: "host-only-gemini",
					VIDEO_BUCKET: {} as R2Bucket,
				},
				input,
				factories,
			);
			const result = await runner.run(
				{
					payload: {},
					instanceId: input.runId,
					timestamp: new Date(),
				} as never,
				{} as never,
			);
			expect(result).toEqual({
				keys: ["EVIDENCE", "MCP", "REASON", "__RUN_CONTEXT__"],
				denied: true,
				secret: null,
				apiKey: null,
			});
			// The unchanged dispatch shim reached its named native ArtifactBridge.
			const artifact = await (env as unknown as { DB: D1Database }).DB.prepare(
				"SELECT path FROM skill_run_artifacts WHERE run_id = ? AND path = 'manifest.json'",
			)
				.bind(input.runId)
				.first<{ path: string }>();
			expect(artifact?.path).toBe("manifest.json");
			expect(captured?.compatibilityFlags).toContain("disallow_importable_env");
			expect(captured?.globalOutbound).toBe(network ? outbound : null);
			expect(JSON.stringify(captured?.env)).not.toContain("host-only-canary");
			expect(JSON.stringify(captured?.env)).not.toContain("host-only-gemini");
		}, 15000);
	it("rejects tenant imports of the Worker environment through the production loader", () => {
		const input = skillInput(false);
		input.code = `import { env } from "cloudflare:workers"; export default { async run() { return env; } };`;
		expect(() =>
			loadSkillRuntime(
				env as unknown as SkillRuntimeEnv,
				input,
				exports as unknown as SkillRuntimeExportFactories,
			),
		).toThrow(/import|cloudflare:workers/i);
	});
});

import {
	createSkillRun as persistAdmittedRun,
	loadSkillRunSnapshot,
} from "./db";
it("persists source consent independently of caller params in a real D1 run snapshot", async () => {
	const db = (env as unknown as { DB: D1Database }).DB;
	await db.exec(
		`CREATE TABLE IF NOT EXISTS skill_runs(id TEXT PRIMARY KEY,skill_id TEXT,tedi_id TEXT,organization_id TEXT,workflow_instance_id TEXT,params TEXT,status TEXT,error TEXT,started_at TEXT,workflow_source TEXT,skill_doc TEXT,skill_revision INTEGER,skill_slug TEXT,capability_manifest TEXT,runtime_environment TEXT,created_by TEXT,work_item_id TEXT,origin_tedi_run_id TEXT,resource_access_envelope TEXT,execution_epoch INTEGER DEFAULT 0,workflow_retired_at TEXT)`,
	);
	const id = crypto.randomUUID();
	const envelope = {
		version: 1 as const,
		sources: [
			{
				workspaceResourceId: id,
				workspaceId: id,
				providerId: "google",
				resourceType: "calendar",
				providerResourceId: "calendar-a",
				connectionScope: "user" as const,
				personalOwnerUserId: "owner",
				connectionInstanceId: id,
				delegationId: id,
				requiredScopes: ["read"],
				operations: ["read"],
				toolIds: ["list_events"],
			},
		],
	};
	await persistAdmittedRun(db, {
		runId: id,
		skillId: id,
		tediId: id,
		orgId: id,
		workflowInstanceId: id,
		params: {
			_tedixContext: { resourceAccessEnvelope: { version: 1, sources: [] } },
		},
		workflowSource: "export default {}",
		skillDoc: "Pinned skill",
		skillRevision: 1,
		skillSlug: "calendar",
		runtimeEnvironment: "development",
		resourceAccessEnvelope: envelope,
	});
	const snapshot = await loadSkillRunSnapshot(db, id);
	expect(snapshot?.resourceAccessEnvelope).toEqual(envelope);
	expect(snapshot?.params).toEqual({
		_tedixContext: { resourceAccessEnvelope: { version: 1, sources: [] } },
	});
});
