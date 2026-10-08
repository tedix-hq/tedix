/**
 * `flow.*` — one-call ephemeral workflows for gateway Code Mode agents.
 *
 * The provider is deliberately a thin composition of the already-mounted
 * inner-tool closures (skills.record_skills, <tedi>.run_skill_workflow, ...),
 * so authorization, receipts, and evidence are identical to direct calls.
 * What is worth pinning: the draft is always ephemeral (tagged, draft,
 * validated), destructive authorization is explicit, error-shaped RESULT
 * values become throws, and run never busy-waits.
 */
import { describe, expect, it } from "vite-plus/test";
import type { NamespaceGroup } from "@tedix/mcp-shared/compact-types";
import {
	attachCodeModeReadObservations,
	buildFlowProvider,
	codeModeCollectionReadMeta,
	codeModeReadObservationMeta,
	collectCodeModeCollectionRead,
	collectCodeModeReadObservation,
} from "./codemode";

it("batches gateway-authored collection reads outside the script result", () => {
	const observation = {
		version: 1,
		kind: "connected_collection_read",
		source: {
			appId: "00000000-0000-4000-8000-000000000001",
			appSlug: "google-gmail",
			toolName: "get_message",
			connectionProviderId: "google-gmail",
		},
		collection: "messages",
		observedAt: "2026-09-27T22:00:00.000Z",
	};
	const into: Array<{ innerCallId: string; observation: unknown }> = [];
	collectCodeModeCollectionRead({
		meta: { "io.tedix/readCollection": observation },
		executionId: "exec",
		innerCallOrdinal: 2,
		into: into as never,
	});
	collectCodeModeCollectionRead({
		meta: {
			"io.tedix/readCollection": { ...observation, collection: "../forged" },
		},
		executionId: "exec",
		innerCallOrdinal: 3,
		into: into as never,
	});
	expect(into).toEqual([{ innerCallId: "exec:2", observation }]);
	expect(codeModeCollectionReadMeta(into as never)).toEqual({
		"io.tedix/readCollections": [{ innerCallId: "exec:2", observation }],
	});
	expect(
		attachCodeModeReadObservations(
			{ isError: true, _meta: { existing: true } },
			[],
			into as never,
		),
	).toEqual({
		isError: true,
		_meta: {
			existing: true,
			"io.tedix/readCollections": [{ innerCallId: "exec:2", observation }],
		},
	});
});

it("collects validated read observations out of band with a stable inner ordinal", () => {
	const into: Array<{ innerCallId: string; receipt: unknown }> = [];
	const receipt = {
		version: 1,
		kind: "docs_file_observation",
		receiptId: "00000000-0000-4000-8000-000000000001",
		provider: { appSlug: "docs", toolName: "get_docs_file" },
		resource: {
			organizationSlug: "acme",
			siteId: "00000000-0000-4000-8000-000000000002",
			path: "index.md",
		},
		evidence: {
			contentSha256: "a".repeat(64),
			byteLength: 6,
			observedGitRevision: "b".repeat(40),
		},
		observedAt: "2026-09-22T12:00:00.000Z",
	};
	collectCodeModeReadObservation({
		meta: { "io.tedix/readObservation": receipt },
		executionId: "exec",
		innerCallOrdinal: 3,
		into: into as never,
	});
	collectCodeModeReadObservation({
		meta: {
			"io.tedix/readObservation": {
				...receipt,
				provider: { appSlug: "evil", toolName: "get_docs_file" },
			},
		},
		executionId: "exec",
		innerCallOrdinal: 4,
		into: into as never,
	});
	expect(into).toEqual([{ innerCallId: "exec:3", receipt }]);
	expect(codeModeReadObservationMeta(into as never)).toEqual({
		"io.tedix/readObservations": [{ innerCallId: "exec:3", receipt }],
	});
	expect(codeModeReadObservationMeta([])).toEqual({});
	expect(
		attachCodeModeReadObservations(
			{ isError: true, _meta: { existing: true } },
			into as never,
		),
	).toEqual({
		isError: true,
		_meta: {
			existing: true,
			"io.tedix/readObservations": [{ innerCallId: "exec:3", receipt }],
		},
	});
});

function makeGroups(
	overrides: {
		record?: (args: Record<string, unknown>) => Promise<unknown>;
		run?: (args: Record<string, unknown>) => Promise<unknown>;
		status?: (args: Record<string, unknown>) => Promise<unknown>;
		inspect?: (args: Record<string, unknown>) => Promise<unknown>;
		list?: (args: Record<string, unknown>) => Promise<unknown>;
	} = {},
) {
	const calls: Array<{ callable: string; args: Record<string, unknown> }> = [];
	const groups = new Map<string, NamespaceGroup>();
	const track =
		(
			callable: string,
			impl?: (args: Record<string, unknown>) => Promise<unknown>,
		) =>
		async (args: Record<string, unknown>) => {
			calls.push({ callable, args });
			return impl ? impl(args) : {};
		};
	groups.set("skills", {
		fns: {
			record_skills: track(
				"skills.record_skills",
				overrides.record ?? (async () => ({ entry: { id: "skill-1" } })),
			),
		},
		schemas: {},
	});
	groups.set("cto", {
		fns: {
			run_skill_workflow: track(
				"cto.run_skill_workflow",
				overrides.run ?? (async () => ({ runId: "run-1" })),
			),
			get_skill_workflow_status: track(
				"cto.get_skill_workflow_status",
				overrides.status ??
					(async () => ({
						status: "completed",
						result: { count: 3 },
						durationMs: 1200,
					})),
			),
			inspect_skill_workflow_run: track(
				"cto.inspect_skill_workflow_run",
				overrides.inspect ?? (async () => ({ steps: [] })),
			),
			list_skill_workflow_history: track(
				"cto.list_skill_workflow_history",
				overrides.list ?? (async () => ({ runs: [] })),
			),
		},
		schemas: {},
	});
	return { groups, calls };
}

function tools(groups: Map<string, NamespaceGroup>) {
	return buildFlowProvider(groups).tools as Record<
		string,
		{ execute: (input: unknown) => Promise<unknown> }
	>;
}

const SOURCE =
	"export default { async run(event, step, env) { return { ok: true }; } };";

describe("flow.run", () => {
	it("checks caller runner authorization before recording a source draft", async () => {
		const { groups, calls } = makeGroups();
		const provider = buildFlowProvider(groups, (namespace) => {
			if (namespace === "cto") throw new Error("runner not authorized");
		});
		const run = (
			provider.tools as Record<
				string,
				{ execute: (input: unknown) => Promise<unknown> }
			>
		).run!;
		await expect(run.execute({ source: SOURCE })).rejects.toThrow(
			"runner not authorized",
		);
		expect(calls).toEqual([]);
	});

	it("rejects missing runners and invalid params before recording any draft", async () => {
		for (const input of [
			{ source: SOURCE, tediSlug: "missing" },
			{ source: SOURCE, params: { __tedixWorkspaceContext: [] } },
			{ source: SOURCE, params: "invalid" },
		]) {
			const { groups, calls } = makeGroups();
			await expect(tools(groups).run!.execute(input)).rejects.toThrow();
			expect(calls).toEqual([]);
		}
	});
	it("checks the mounted runner schema before recording a draft", async () => {
		const { groups, calls } = makeGroups();
		groups.get("cto")!.schemas.run_skill_workflow = {
			description: "run",
			inputSchema: {
				type: "object",
				properties: {
					skillId: { type: "string", format: "uuid" },
					workItemId: { type: "string", format: "uuid" },
				},
				required: ["skillId"],
			},
		};
		await expect(
			tools(groups).run!.execute({ source: SOURCE, workItemId: "invalid" }),
		).rejects.toThrow("runner arguments invalid");
		expect(calls).toEqual([]);
	});

	it("pins bounded workspace references into the durable run params", async () => {
		const { groups, calls } = makeGroups();
		const result = await tools(groups).run!.execute({
			skillId: "skill-1",
			workspaceContext: [
				{
					kind: "file",
					uri: "workspace://ws-1/files/brief.md",
					revision: "sha256:abc",
				},
				{ kind: "resource", uri: "ui://widgets/tedix/brief" },
			],
		});
		const dispatch = calls.find((call) =>
			call.callable.endsWith(".run_skill_workflow"),
		);
		expect(dispatch?.args.params).toEqual({
			__tedixWorkspaceContext: [
				{
					kind: "file",
					uri: "workspace://ws-1/files/brief.md",
					revision: "sha256:abc",
				},
				{ kind: "resource", uri: "ui://widgets/tedix/brief" },
			],
		});
		expect(result).toMatchObject({ workspaceContext: expect.any(Array) });
	});

	it("rejects inline payloads and the reserved context parameter", async () => {
		const { groups } = makeGroups();
		await expect(
			tools(groups).run!.execute({
				skillId: "skill-1",
				workspaceContext: [{ kind: "file", content: "bulk payload" }],
			}),
		).rejects.toThrow("workspaceContext[0] is invalid");
		await expect(
			tools(groups).run!.execute({
				skillId: "skill-1",
				params: { __tedixWorkspaceContext: [] },
			}),
		).rejects.toThrow("is reserved");
	});
	it("records an ephemeral tagged draft and starts it in one call", async () => {
		const { groups, calls } = makeGroups();
		const result = (await tools(groups).run!.execute({
			source: SOURCE,
			name: "sweep",
			workItemId: "5eed0033-0000-4000-8000-000000000033",
			capabilities: { mcp: { app_config: ["list_app_tools"] } },
		})) as Record<string, unknown>;
		expect(result).toMatchObject({
			skillId: "skill-1",
			runId: "run-1",
			status: "queued",
			workItemId: "5eed0033-0000-4000-8000-000000000033",
		});
		const record = calls.find((c) => c.callable === "skills.record_skills")!;
		// Ephemeral by construction, and part of the adoption cohort the CLI
		// stamps — gateway and CLI usage stay one queryable population.
		expect(record.args.lifecycleState).toBe("draft");
		expect(record.args.tags).toEqual(["flow-ephemeral"]);
		expect(record.args.validate).toBe("error");
		// The manifest must survive into frontmatter — JSON is valid YAML, and
		// the platform validator stays the single authority on its shape.
		expect(String(record.args.content)).toContain(
			'capabilities: {"mcp":{"app_config":["list_app_tools"]}}',
		);
		const run = calls.find((c) => c.callable === "cto.run_skill_workflow")!;
		expect(run.args.skillId).toBe("skill-1");
		expect(run.args.workItemId).toBe("5eed0033-0000-4000-8000-000000000033");
		// Destructive-governed run path: stateless callers authorize explicitly.
		expect(run.args.confirmDestructive).toBe(true);
		expect(String(run.args.reason)).toContain("sweep");
	});

	it("keeps frontmatter valid YAML when name/description hold colons, quotes, newlines", async () => {
		const { parseSkillFrontmatter } =
			await import("@tedix/api-contract/utils/skill-manifest");
		const description = 'Sweep: count "tools"\nsecond line # not a comment';
		const name = "sweep: v2";
		const { groups, calls } = makeGroups();
		await tools(groups).run!.execute({
			source: SOURCE,
			name,
			description,
			capabilities: { mcp: { app_config: ["list_app_tools"] } },
		});
		const record = calls.find((c) => c.callable === "skills.record_skills")!;
		const frontmatter = parseSkillFrontmatter(String(record.args.content));
		expect(frontmatter).toMatchObject({
			name,
			description,
			capabilities: { mcp: { app_config: ["list_app_tools"] } },
		});
	});

	it("routes through the tedi named by tediSlug and rejects garbage slugs", async () => {
		const { groups, calls } = makeGroups();
		await tools(groups).run!.execute({ source: SOURCE, tediSlug: "cto" });
		expect(calls.some((c) => c.callable === "cto.run_skill_workflow")).toBe(
			true,
		);
		await expect(
			tools(groups).run!.execute({ source: SOURCE, tediSlug: "../evil" }),
		).rejects.toThrow(/invalid tediSlug/);
	});

	it("preserves a caller-supplied SKILL.md manifest verbatim", async () => {
		const { groups, calls } = makeGroups();
		const skillDoc = `---\nname: sweep\ncapabilities:\n  mcp:\n    app_config: [list_app_tools]\n---\n`;
		await tools(groups).run!.execute({
			source: SOURCE,
			name: "sweep",
			skillDoc,
		});
		const record = calls.find(
			(call) => call.callable === "skills.record_skills",
		)!;
		expect(record.args.content).toBe(skillDoc);
	});

	it("uses the sole mounted workflow tedi when cto is absent", async () => {
		const { groups, calls } = makeGroups();
		groups.set("operator", groups.get("cto")!);
		groups.delete("cto");
		const result = (await tools(groups).run!.execute({
			skillId: "skill-existing",
		})) as Record<string, unknown>;
		expect(result.tediSlug).toBe("operator");
		expect(
			calls.some((call) => call.callable === "cto.run_skill_workflow"),
		).toBe(true);
	});

	it("requires tediSlug when several non-cto workflow tedis are mounted", async () => {
		const { groups } = makeGroups();
		const tedi = groups.get("cto")!;
		groups.delete("cto");
		groups.set("operator", tedi);
		groups.set("reviewer", tedi);
		await expect(
			tools(groups).run!.execute({ skillId: "skill-existing" }),
		).rejects.toThrow(/multiple tedi namespaces/);
	});

	it("throws on error-shaped RESULT values instead of returning a phantom id", async () => {
		// oRPC contract errors cross Code Mode as values, not throws — a failed
		// record must never be mistaken for a recorded skill.
		const { groups } = makeGroups({
			record: async () => ({
				defined: true,
				code: "BAD_REQUEST",
				status: 400,
				message: "no manifest",
			}),
		});
		await expect(
			tools(groups).run!.execute({ source: SOURCE }),
		).rejects.toThrow(/skills.record_skills failed/);
	});

	it("fails with a mount hint when the needed namespaces are absent", async () => {
		const provider = buildFlowProvider(new Map());
		const run = (
			provider.tools as Record<
				string,
				{ execute: (i: unknown) => Promise<unknown> }
			>
		).run!;
		await expect(run.execute({ source: SOURCE })).rejects.toThrow(
			/mounted on this gateway/,
		);
	});

	it("reruns an existing skill via skillId without recording", async () => {
		const { groups, calls } = makeGroups();
		const result = (await tools(groups).run!.execute({
			skillId: "skill-existing",
		})) as Record<string, unknown>;
		expect(result).toMatchObject({ skillId: "skill-existing", runId: "run-1" });
		expect(calls.some((c) => c.callable === "skills.record_skills")).toBe(
			false,
		);
	});

	it("turns the near-duplicate refusal into the skillId rerun path", async () => {
		// A retry is a near-dupe of itself by definition, but silently mutating
		// the 90%-similar skill the gate names could hit a real library asset —
		// so the refusal becomes actionable guidance instead.
		const { groups } = makeGroups({
			record: async () => ({
				ok: false,
				error:
					'CONFLICT: Refusing to create a near-duplicate skill: an existing skill has an equivalent title ("x", x). Prefer modifying it: improve_skills({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", ... }).',
			}),
		});
		await expect(
			tools(groups).run!.execute({ source: SOURCE }),
		).rejects.toThrow(
			/flow\.run\(\{ skillId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"/,
		);
	});

	it("requires source", async () => {
		const { groups } = makeGroups();
		await expect(tools(groups).run!.execute({})).rejects.toThrow(
			/requires `source`.*or `skillId`/,
		);
	});
});

describe("flow.status", () => {
	it("returns the bounded projection so a poll stays small by construction", async () => {
		const { groups } = makeGroups();
		const status = (await tools(groups).status!.execute({
			runId: "run-1",
		})) as Record<string, unknown>;
		// Same contract as the CLI projection: the run's own `result` field maps
		// to `output` and can never eat the envelope.
		expect(status).toEqual({
			status: "completed",
			output: { count: 3 },
			error: null,
			durationMs: 1200,
		});
	});
});

describe("flow.list", () => {
	it("lists recent runs through the selected workflow tedi", async () => {
		const { groups, calls } = makeGroups({
			list: async () => ({ runs: [{ runId: "run-1" }] }),
		});
		const result = await tools(groups).list!.execute({ limit: 3 });
		expect(result).toEqual({ runs: [{ runId: "run-1" }] });
		expect(calls.at(-1)).toEqual({
			callable: "cto.list_skill_workflow_history",
			args: { limit: 3, skillTag: "flow-ephemeral" },
		});
	});
});

describe("flow.tools", () => {
	it("returns the exact selected tedi inventory and a copyable manifest", async () => {
		const { groups } = makeGroups();
		const result = (await tools(groups).tools!.execute({})) as Record<
			string,
			unknown
		>;
		expect(result).toEqual({
			tediSlug: "cto",
			namespace: "tedi",
			methods: [
				"get_skill_workflow_status",
				"inspect_skill_workflow_run",
				"list_skill_workflow_history",
				"run_skill_workflow",
			],
			manifest: {
				mcp: {
					tedi: [
						"get_skill_workflow_status",
						"inspect_skill_workflow_run",
						"list_skill_workflow_history",
						"run_skill_workflow",
					],
				},
			},
		});
	});
});

describe("flow.inspect", () => {
	it("returns the complete evidence view through the selected tedi", async () => {
		const { groups, calls } = makeGroups({
			inspect: async () => ({ steps: [{ id: "step-1" }] }),
		});
		await expect(
			tools(groups).inspect!.execute({ runId: "run-1" }),
		).resolves.toEqual({ steps: [{ id: "step-1" }] });
		expect(calls.at(-1)).toEqual({
			callable: "cto.inspect_skill_workflow_run",
			args: { runId: "run-1" },
		});
	});
});
