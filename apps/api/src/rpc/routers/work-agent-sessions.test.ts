import { organizationMembers } from "@tedix/db/schema/organization-members";
import { workInteractions } from "@tedix/db/schema/work-factory";
import { projects } from "@tedix/db/schema/projects";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { skillRuns } from "@tedix/db/schema/cognitive";
import {
	kernelRuntimeRuns,
	kernelConversations,
	kernelConversationGrants,
} from "@tedix/db/schema/cognitive-runtime";
import { tedis } from "@tedix/db/schema/tedis";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { agentSessionRequests } from "@tedix/db/schema/agent-session-requests";
import {
	osWorkspaces,
	osWorkspaceProjects,
	osGadgetExecutions,
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
	for (const table of [
		projects,
		organizationMembers,
		workItems,
		workAttempts,
		workInteractions,
		skillRuns,
		kernelRuntimeRuns,
		kernelConversations,
		kernelConversationGrants,
		tedis,
		tediObjectives,
		agentSessionRequests,
		osWorkspaces,
		osWorkspaceProjects,
		osGadgetExecutions,
	])
		sqlite.exec(schemaDdl(table));
	const facade = createD1Facade(sqlite);
	const baseContext = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/workAgentSessions"),
	};
	const userClient = (userId: string) =>
		createRouterClient(workAgentSessionsContractRouter, {
			context: {
				...baseContext,
				authType: "user",
				userId,
				userRole: "member",
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
		grace: userClient("grace"),
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
});
