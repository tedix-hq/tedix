import {
	learningInteractionEvents,
	learningImprovementProposals,
} from "@tedix/db/schema/learning-feedback";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { projects } from "@tedix/db/schema/projects";
import { organizations } from "@tedix/db/schema/organizations";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { skillRuns } from "@tedix/db/schema/cognitive";
import {
	kernelRuntimeRuns,
	kernelConversations,
	kernelConversationGrants,
} from "@tedix/db/schema/cognitive-runtime";
import { tedis } from "@tedix/db/schema/tedis";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import {
	agentSessionEvents,
	agentSessionRequests,
} from "@tedix/db/schema/agent-session-requests";
import { recordAgentSessionEvents } from "@tedix/db/queries/agent-session-requests";
import { LaneTelemetryInputSchema } from "@tedix/api-contract/schemas/work-agent-sessions";
import {
	osWorkspaces,
	osWorkspaceProjects,
	osGadgetExecutions,
	osOutputs,
	osGadgets,
	osWorkspaceResources,
} from "@tedix/db/schema/os-workspaces";
import { DEFAULT_ATTENTION_LAYOUT } from "@tedix/api-contract/schemas/attention-layout";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { workAgentSessionsContractRouter } from "./work-agent-sessions";

const continuity = vi.hoisted(() => ({
	read: vi
		.fn<typeof import("../../lib/stall-attention").readContinuity>()
		.mockResolvedValue({ stalls: [], promises: [], next: null }),
}));
vi.mock("../../lib/stall-attention", () => ({
	readContinuity: continuity.read,
}));

const ORG_ID = "00000000-0000-4000-8000-000000000001";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(workAgentSessions));
	sqlite.exec(schemaDdl(userConfigs));
	sqlite.exec(schemaDdl(learningInteractionEvents));
	for (const table of [
		organizations,
		projects,
		learningImprovementProposals,
		organizationMembers,
		workItems,
		workAttempts,
		workInteractions,
		skillRuns,
		agentSessionEvents,
		kernelRuntimeRuns,
		kernelConversations,
		kernelConversationGrants,
		tedis,
		tediObjectives,
		agentSessionRequests,
		osWorkspaces,
		osWorkspaceProjects,
		osGadgetExecutions,
		osOutputs,
		osGadgets,
		osWorkspaceResources,
	])
		sqlite.exec(schemaDdl(table));
	const queued: unknown[] = [];
	const facade = createD1Facade(sqlite);
	const baseContext = {
		db: createDbClient(facade),
		env: {
			ENVIRONMENT: "test",
			DB: facade,
			AUTOMATION_EVENTS: {
				send: async (body: unknown) => {
					queued.push(body);
				},
			},
		} as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/workAgentSessions"),
	};
	const userClient = (userId: string, userRole = "member") =>
		createRouterClient(workAgentSessionsContractRouter, {
			context: {
				...baseContext,
				authType: "user",
				userId,
				userRole,
				user: {
					aud: "test",
					dct: "tenant-1",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					permissions: [],
					roles: [],
					sub: `${userId}-sub`,
				},
			} as BaseContext,
		});
	const tediClient = createRouterClient(workAgentSessionsContractRouter, {
		context: {
			...baseContext,
			organizationId: undefined,
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": ORG_ID,
				"X-Tedix-Tedi-Id": "55555555-5555-4555-8555-555555555555",
				"X-Tedix-Tedi-Scopes": "mcp:work.read mcp:work.write",
			}),
		} as BaseContext,
	});
	return {
		sqlite,
		ada: userClient("ada"),
		owner: userClient("owner", "owner"),
		queued,
		grace: userClient("grace"),
		db: baseContext.db,
		tediClient,
	};
}

const report = {
	harness: "claude-code" as const,
	sessionKey: "session-1",
	state: "needs_you" as const,
	summary: "Waiting\u0007 for\n\napproval\u001b[31m",
	label: "  tedix\tmain  ",
};

describe("workAgentSessions router", () => {
	it("remaps existing chats without refreshing liveness and ignores foreign project targets", async () => {
		const { sqlite, ada } = fixture();
		const customer = "11111111-1111-4111-8111-111111111111";
		const foreign = "22222222-2222-4222-8222-222222222222";
		for (const [id, org] of [
			[customer, ORG_ID],
			[foreign, "other-org"],
		])
			sqlite
				.prepare(
					"INSERT INTO projects (id, org_id, key, name, created_at) VALUES (?, ?, ?, 'Example', CURRENT_TIMESTAMP)",
				)
				.run(id, org, id);
		const initial = await ada.report({ ...report, label: "ACME: research" });
		sqlite
			.prepare(
				"INSERT INTO organizations (id, name, slug, metadata) VALUES (?, 'Example', 'example', ?)",
			)
			.run(
				ORG_ID,
				JSON.stringify({
					sessionProjectBindings: [
						{ prefix: "ACME", projectId: customer },
						{ prefix: "ACME: secret", projectId: foreign },
					],
				}),
			);
		const row = (await ada.list({})).sessions.find(
			(s) => s.sessionKey === report.sessionKey,
		)!;
		expect(row.projectId).toBe(customer);
		expect(row.lastEventAt).toBe(initial.session.lastEventAt);
		expect(
			(await ada.report({ ...report, label: "ACME: secret" })).session
				.projectId,
		).toBe(customer);
	});
	it("routes named chats by org settings while linked Work wins over prefix and checkout", async () => {
		const { sqlite, ada } = fixture();
		const customer = "11111111-1111-4111-8111-111111111111";
		const engineering = "22222222-2222-4222-8222-222222222222";
		const work = "33333333-3333-4333-8333-333333333333";
		sqlite
			.prepare(
				"INSERT INTO organizations (id, name, slug, metadata) VALUES (?, 'Example', 'example', ?)",
			)
			.run(
				ORG_ID,
				JSON.stringify({
					sessionProjectBindings: [{ prefix: "ACME", projectId: customer }],
				}),
			);
		for (const [id, key] of [
			[customer, "CUSTOMER"],
			[engineering, "ENG"],
		])
			sqlite
				.prepare(
					"INSERT INTO projects (id, org_id, key, name, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
				)
				.run(id, ORG_ID, key, key);
		sqlite
			.prepare(
				"INSERT INTO work_items (id, org_id, title, project_id, created_at) VALUES (?, ?, 'Repair identity', ?, CURRENT_TIMESTAMP)",
			)
			.run(work, ORG_ID, engineering);
		expect(
			(
				await ada.report({
					...report,
					label: "acme: research",
					projectId: engineering,
				})
			).session.projectId,
		).toBe(customer);
		expect(
			(
				await ada.report({
					...report,
					label: "ACME",
					workItemId: work,
					projectId: customer,
				})
			).session.projectId,
		).toBe(engineering);
		const fallback = await ada.report({
			...report,
			label: "",
			workItemId: work,
		});
		expect(fallback.session.label).toBe("Repair identity");
	});
	it("records a sanitized report for the calling human and lists it", async () => {
		const { ada } = fixture();
		const first = await ada.report(report);
		expect(first.changed).toBe(true);
		expect(first.session).toMatchObject({
			state: "needs_you",
			effectiveState: "needs_you",
			summary: "Waiting for approval [31m",
			label: "tedix main",
		});
		expect((await ada.report(report)).changed).toBe(false);

		const board = await ada.list({});
		expect(board.sessions.map((session) => session.sessionKey)).toEqual([
			"session-1",
		]);
		expect(board.counts).toEqual({
			needs_you: 1,
			error: 0,
			done: 0,
			working: 0,
			idle: 0,
			ended: 0,
		});
	});

	it("never shows one user's sessions to another", async () => {
		const { ada, grace } = fixture();
		await ada.report(report);
		expect((await grace.list({})).sessions).toEqual([]);
	});

	it("hides ended sessions unless asked", async () => {
		const { ada } = fixture();
		await ada.report({ ...report, state: "ended" });
		expect((await ada.list({})).sessions).toEqual([]);
		expect(
			(await ada.list({ includeEnded: true })).sessions.map(
				(session) => session.effectiveState,
			),
		).toEqual(["ended"]);
	});

	it("returns full stored Work briefs without breaking the session board", async () => {
		const { ada, sqlite } = fixture();
		const db = createDbClient(createD1Facade(sqlite));
		const now = new Date().toISOString();
		const workItemId = "11111111-1111-4111-8111-111111111111";
		const brief = "Review the fictional supplier's delivery. ".repeat(2200);
		await db.insert(workItems).values({
			id: workItemId,
			orgId: ORG_ID,
			title: "Supplier review",
			description: brief,
			createdAt: now,
		});
		await db.insert(workAttempts).values({
			id: "22222222-2222-4222-8222-222222222222",
			orgId: ORG_ID,
			workItemId,
			executorType: "tedi",
			executorId: "supplier-reviewer",
			attemptNumber: 1,
			startedAt: now,
			heartbeatAt: now,
		});
		await ada.report(report);
		const board = await ada.list({});
		expect(board.sessions).toHaveLength(2);
		const telemetry = board.sessions.find(
			(session) => session.harness === "tedi",
		)?.telemetry;
		expect(telemetry?.brief).toBe(brief);
		expect(board.counts.working).toBe(1);
		expect(board.counts.needs_you).toBe(1);
		expect(LaneTelemetryInputSchema.safeParse(telemetry).success).toBe(false);
	});
	it("shows the latest requesting chat when the session has no lane brief", async () => {
		const { ada, grace, sqlite } = fixture();
		const db = createDbClient(createD1Facade(sqlite));
		const now = new Date().toISOString();
		await db.insert(agentSessionRequests).values({
			id: crypto.randomUUID(),
			organizationId: ORG_ID,
			userId: "ada",
			harness: report.harness,
			sessionKey: report.sessionKey,
			kind: "request",
			text: "Make the fictional widget readable",
			status: "in_progress",
			sourceAt: now,
			sourceKey: "request-1",
			statusChangedAt: now,
		});
		await ada.report({ ...report, state: "working" });
		expect((await ada.list({})).sessions[0]?.brief).toBe(
			"Make the fictional widget readable",
		);
		expect((await grace.list({})).sessions).toEqual([]);
	});

	it("rejects non-human principals", async () => {
		const { tediClient } = fixture();
		await expect(tediClient.report(report)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(tediClient.list({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("stored session event owner read", () => {
	it("returns exact owner events, pagination and explicit missing UTC dates", async () => {
		const { ada, grace, db, tediClient } = fixture();
		for (const [organizationId, userId, sourceAt, sourceKey, activity] of [
			[ORG_ID, "ada", "2026-10-25T12:00:00.000Z", "ada-old", null],
			[
				ORG_ID,
				"ada",
				"2026-10-26T12:00:00.000Z",
				"ada-new",
				"tool failure digest",
			],
			[ORG_ID, "grace", "2026-10-26T12:00:00.000Z", "grace", null],
			["other-org", "ada", "2026-10-26T12:00:00.000Z", "other-org", null],
		] as const)
			await recordAgentSessionEvents(db, {
				organizationId,
				userId,
				now: sourceAt,
				events: [
					{
						kind: "turn",
						harness: "opencode",
						sessionKey: "session-1",
						repository: "tedix",
						sourceAt,
						sourceKey,
						body: sourceKey,
						activity,
					},
				],
			});

		const first = await ada.listEvents({
			since: "2026-10-24T00:00:00.000Z",
			until: "2026-10-27T00:00:00.000Z",
			limit: 1,
		});
		expect(first.data).toHaveLength(1);
		expect(first.data[0]).toMatchObject({
			harness: "opencode",
			repository: "tedix",
			text: "ada-new",
			activity: "tool failure digest",
		});
		expect(first.data[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(first.coverage).toEqual({
			from: "2026-10-24T00:00:00.000Z",
			through: "2026-10-27T00:00:00.000Z",
			days: [
				{ date: "2026-10-25", eventCount: 1, activityDigestCount: 0 },
				{ date: "2026-10-26", eventCount: 1, activityDigestCount: 1 },
			],
			missingDates: ["2026-10-24", "2026-10-27"],
		});
		const second = await ada.listEvents({
			since: first.coverage.from,
			until: first.coverage.through,
			cursor: first.nextCursor!,
			limit: 1,
		});
		expect(second.data.map((event) => event.text)).toEqual(["ada-old"]);
		expect(second.nextCursor).toBeNull();
		expect(
			(
				await grace.listEvents({
					since: "2026-10-24T00:00:00.000Z",
					until: "2026-10-27T00:00:00.000Z",
				})
			).data.map((event) => event.text),
		).toEqual(["grace"]);
		await expect(
			tediClient.listEvents({
				since: "2026-10-24T00:00:00.000Z",
				until: "2026-10-27T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("Attention composition", () => {
	it("keeps layouts private and rejects stale concurrent edits", async () => {
		const { ada, grace, tediClient } = fixture();
		expect((await ada.getAttentionLayout({})).revision).toBe(0);
		const layout = {
			...DEFAULT_ATTENTION_LAYOUT,
			focusToday: "Search",
			hiddenColumns: ["done" as const],
		};
		expect(
			(await ada.updateAttentionLayout({ layout, expectedRevision: 0 }))
				.revision,
		).toBe(1);
		expect((await ada.getAttentionLayout({})).layout.focusToday).toBe("Search");
		expect((await grace.getAttentionLayout({})).layout.focusToday).toBe("");
		await expect(
			ada.updateAttentionLayout({ layout, expectedRevision: 0 }),
		).rejects.toThrow(/layout changed/);
		await expect(
			tediClient.updateAttentionLayout({ layout, expectedRevision: 1 }),
		).rejects.toThrow();
	});
	it("remembers visits across clients without changing another person's visit", async () => {
		const { ada, grace } = fixture();
		expect((await ada.visitAttention({})).previousVisitAt).toBeNull();
		expect((await ada.visitAttention({})).previousVisitAt).toMatch(/^20/);
		expect((await grace.visitAttention({})).previousVisitAt).toBeNull();
	});
});

it("scopes the embedded view to linked projects and checks workspace visibility", async () => {
	const { ada, grace, sqlite } = fixture();
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(osWorkspaces).values({
		id: "workspace-example",
		organizationId: ORG_ID,
		name: "Supply",
		visibility: "private",
		ownerUserId: "ada-sub",
		createdByKind: "user",
		createdById: "ada-sub",
	});
	for (const id of ["supply", "other"]) {
		await db.insert(projects).values({
			id,
			orgId: ORG_ID,
			name: id,
			key: id,
			createdAt: new Date().toISOString(),
		});
		await db.insert(workItems).values({
			id: `item-${id}`,
			orgId: ORG_ID,
			title: id,
			projectId: id,
			disposition: "accepted",
			createdAt: new Date().toISOString(),
		});
	}
	await db.insert(osWorkspaceProjects).values({
		id: "link-example",
		organizationId: ORG_ID,
		workspaceId: "workspace-example",
		projectId: "supply",
		createdByKind: "user",
		createdById: "ada-sub",
	});
	continuity.read.mockResolvedValueOnce({
		stalls: ["supply", "other"].map((scopeId) => ({
			scopeId,
			name: scopeId,
			cause: "Waiting for a reply",
			reason: "Choose the next step",
			href: "/work/needs-you",
			requestedAt: new Date().toISOString(),
			needsYou: true,
		})),
		promises: [],
		next: null,
	});
	const result = await ada.attention({
		workspaceId: "workspace-example",
		utcOffsetMinutes: 0,
	});
	expect(result.projects.map((p) => p.id)).toEqual(["supply"]);
	expect(result.cards.map((c) => c.title)).toEqual(["supply"]);
	expect(result.unfiled).toEqual([]);
	expect(result.stalls?.map((s) => s.scopeId)).toEqual(["supply"]);
	await expect(
		grace.attention({ workspaceId: "workspace-example", utcOffsetMinutes: 0 }),
	).rejects.toThrow();
});

it("lets an active personal tedi edit only its owner's layout and rejects a revoked owner", async () => {
	const { ada, grace, tediClient, sqlite } = fixture();
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(tedis).values({
		id: "55555555-5555-4555-8555-555555555555",
		organizationId: ORG_ID,
		name: "Personal helper",
		slug: "personal-helper",
		scope: "personal",
		ownerUserId: "ada-sub",
		status: "active",
	});
	await db.insert(organizationMembers).values({
		id: "member-ada",
		organizationId: ORG_ID,
		userId: "ada",
		descopeUserId: "ada-sub",
		email: "ada@example.test",
		status: "active",
		role: "member",
	});
	expect((await tediClient.getAttentionLayout({})).revision).toBe(0);
	await tediClient.updateAttentionLayout({
		expectedRevision: 0,
		layout: { ...DEFAULT_ATTENTION_LAYOUT, focusToday: "Supply" },
	});
	expect((await ada.getAttentionLayout({})).layout.focusToday).toBe("Supply");
	expect((await grace.getAttentionLayout({})).layout.focusToday).toBe("");
	await db.delete(organizationMembers);
	await expect(tediClient.getAttentionLayout({})).rejects.toThrow(
		/active membership/,
	);
	await expect(
		tediClient.updateAttentionLayout({
			expectedRevision: 1,
			layout: DEFAULT_ATTENTION_LAYOUT,
		}),
	).rejects.toThrow(/active membership/);
});

it("backfilling an old unfinished lane does not claim fresh activity", async () => {
	const { ada } = fixture();
	const observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const result = await ada.report({
		...report,
		state: "working",
		telemetry: {
			executor: "codex",
			model: null,
			provider: null,
			reasoningEffort: null,
			brief: "Fix a fictional widget",
			startedAt: observedAt,
			heartbeatAt: observedAt,
			finishedAt: null,
			outcome: null,
			finalMessage: "",
			tools: {},
			usage: null,
			shas: [],
			workItems: [],
			corrections: [],
			source: "import",
		},
	});
	expect(result.session.lastEventAt).toBe(observedAt);
	expect(result.session.effectiveState).toBe("idle");
	expect(result.session.state).toBe("idle");
	const board = await ada.list({});
	expect(board.counts.working).toBe(0);
	expect(board.counts.idle).toBe(1);
	expect(board.sessions[0]).toMatchObject({
		state: "idle",
		effectiveState: "idle",
	});
});

it("uses the saved Attention timeout for rows and counts, then expires a silent session", async () => {
	const { ada, sqlite } = fixture();
	await ada.updateAttentionLayout({
		expectedRevision: 0,
		layout: { ...DEFAULT_ATTENTION_LAYOUT, sessionInactiveAfterMinutes: 10 },
	});
	await ada.report({ ...report, state: "working" });
	sqlite
		.prepare("UPDATE work_agent_sessions SET last_event_at = ?")
		.run(new Date(Date.now() - 6 * 60_000).toISOString());
	let board = await ada.list({});
	expect(board.counts.working).toBe(1);
	expect(board.sessions[0]).toMatchObject({
		state: "working",
		effectiveState: "working",
	});
	sqlite
		.prepare("UPDATE work_agent_sessions SET last_event_at = ?")
		.run(new Date(Date.now() - 11 * 60_000).toISOString());
	board = await ada.list({});
	expect(board.counts.working).toBe(0);
	expect(board.counts.idle).toBe(1);
	expect(board.sessions[0]).toMatchObject({
		state: "idle",
		effectiveState: "idle",
	});
});

it("keeps automatic container creation behind existing project permission and explicit owner opt-in", async () => {
	const { ada, owner, queued, tediClient } = fixture();
	await expect(ada.classifyRequests({ enabled: true })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(
		tediClient.classifyRequests({ enabled: true }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(await owner.classifyRequests({ enabled: true })).toEqual({
		queued: true,
	});
	expect(queued).toEqual([
		{
			kind: "request_filing",
			organizationId: ORG_ID,
			userId: "owner",
			ownerSubject: "owner-sub",
		},
	]);
	expect(await owner.classifyRequests({ enabled: false })).toEqual({
		queued: false,
	});
	expect(queued).toHaveLength(1);
});

it("validates intake ownership and prevents viewers changing it while disabling", async () => {
	const { owner, ada, sqlite } = fixture();
	const id = "00000000-0000-4000-8000-000000000099";
	await expect(
		ada.classifyRequests({ enabled: false, intakeProjectId: id }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		owner.classifyRequests({ intakeProjectId: id }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(projects).values({
		id,
		orgId: "other-org",
		key: "INTAKE",
		name: "Intake",
		createdAt: "2026-10-10T10:00:00Z",
	});
	await expect(
		owner.classifyRequests({ intakeProjectId: id }),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
	await db.update(projects).set({ orgId: ORG_ID });
	expect(
		await owner.classifyRequests({ enabled: false, intakeProjectId: id }),
	).toEqual({ queued: false, intakeProjectId: id });
});

it("reports fresh membership fences for an immediate filing pass without claiming it ran", async () => {
	const { owner, ada, queued, sqlite } = fixture();
	await expect(
		ada.classifyRequests({ enabled: true, runNow: true }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(await owner.classifyRequests({ enabled: true, runNow: true })).toEqual(
		{ queued: false, pass: { state: "inactive_owner" } },
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizationMembers).values({
		id: "member-owner",
		organizationId: ORG_ID,
		userId: "owner",
		descopeUserId: "owner-sub",
		email: "owner@example.test",
		status: "active",
		role: "viewer",
	});
	expect(await owner.classifyRequests({ runNow: true })).toEqual({
		queued: false,
		pass: { state: "permission_denied" },
	});
	expect(queued).toHaveLength(0);
});

it("returns an immediate empty pass and surfaces storage failures instead of reporting queue success", async () => {
	const { owner, queued, sqlite } = fixture();
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(organizationMembers).values({
		id: "member-owner",
		organizationId: ORG_ID,
		userId: "owner",
		descopeUserId: "owner-sub",
		email: "owner@example.test",
		status: "active",
		role: "owner",
	});
	expect(await owner.classifyRequests({ enabled: true, runNow: true })).toEqual(
		{ queued: false, pass: { state: "processed", pending: 0 } },
	);
	sqlite.exec("DROP TABLE projects");
	await expect(owner.classifyRequests({ runNow: true })).rejects.toMatchObject({
		code: "SERVICE_UNAVAILABLE",
		message: "no such table: projects",
	});
	expect(queued).toHaveLength(0);
});

it("keeps OpenCode reports private to the reporting user", async () => {
	const { ada, grace } = fixture();
	const input = {
		...report,
		harness: "opencode" as const,
		sessionKey: "ses_ea08bec38ffeGv2rruD2pzxAuC",
	};
	const saved = await ada.report(input);
	expect(saved.session.harness).toBe("opencode");
	expect((await ada.list({})).sessions).toHaveLength(1);
	expect((await grace.list({})).sessions).toEqual([]);
});
