import { eq } from "drizzle-orm";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	agentSessionEvents,
	agentSessionRequests,
} from "@tedix/db/schema/agent-session-requests";
import { projects } from "@tedix/db/schema/projects";
import { organizations } from "@tedix/db/schema/organizations";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import {
	osWorkspaces,
	osWorkspaceProjects,
} from "@tedix/db/schema/os-workspaces";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import {
	recordAgentSessionRequests,
	listAgentSessionRequests,
} from "@tedix/db/queries/agent-session-requests";
import {
	listRequestFilings,
	recordRequestFiling,
	weeklyFilingDigest,
} from "@tedix/db/queries/request-filings";
import { getWorkItemBySourceIntentId } from "@tedix/db/queries/work-items/crud";
import { autoFileRequests } from "./request-auto-filing";
import type { LedgerModel } from "./agent-session-request-ledger";
const owner = { organizationId: "org-example", userId: "user-ada" };
const now = "2026-10-10T10:00:00.000Z";
const pick = {
	projectId: "project-docs",
	name: "Installation guides",
	brief: "Make installation easier",
	container: "project",
	actionable: true,
	reason: "Matches the installation brief",
};
async function fixture(
	kind: "request" | "ask" | "idea" | "issue" | "question" = "request",
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	for (const table of [
		organizations,
		agentSessionEvents,
		agentSessionRequests,
		projects,
		tediObjectives,
		workItems,
		workEvents,
		workAgentSessions,
		osWorkspaces,
		osWorkspaceProjects,
		learningInteractionEvents,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(projects).values({
		id: "project-docs",
		orgId: owner.organizationId,
		key: "DOCS",
		name: "Documentation",
		description: "Installation guides",
		createdAt: now,
	});
	const [row] = await recordAgentSessionRequests(db, {
		...owner,
		harness: "codex",
		sessionKey: "session-example",
		sourceKey: "prompt-example",
		sourceAt: now,
		now,
		repository: "example/app",
		requests: [{ kind, text: "Improve installation guides" }],
	});
	const model: LedgerModel = vi.fn(async () => JSON.stringify(pick));
	model.chooseProject = vi.fn(async () => ({
		projectId: "project-docs",
		confidence: 0.9,
		actionable: true,
	}));
	return { db, row: row!, model };
}

describe("automatic filing", () => {
	it("chooses live projects before writing and retries Work idempotently", async () => {
		const { db, row, model } = await fixture();
		await autoFileRequests(db, model, { ...owner, now });
		await autoFileRequests(db, model, { ...owner, now });
		expect(model).not.toHaveBeenCalled();
		expect(model.chooseProject).toHaveBeenCalledOnce();
		expect((await listAgentSessionRequests(db, owner))[0]).toMatchObject({
			projectId: "project-docs",
			status: "open",
		});
		expect(await listRequestFilings(db, owner)).toHaveLength(1);
		expect(
			(
				await getWorkItemBySourceIntentId(db, {
					orgId: owner.organizationId,
					sourceIntentId: `request-filing:${row.id}`,
				})
			)?.disposition,
		).toBe("proposed");
	});
	it("writes only a confident novel container brief and keeps it pending", async () => {
		const { db, model } = await fixture();
		model.chooseProject = vi.fn(async () => ({
			projectId: "NONE",
			confidence: 0.95,
			actionable: true,
		}));
		const writer: LedgerModel = vi.fn(async () =>
			JSON.stringify({ ...pick, projectId: null }),
		);
		writer.chooseProject = model.chooseProject;
		await autoFileRequests(db, writer, {
			...owner,
			now,
			intakeProjectId: "project-docs",
		});
		expect(writer).toHaveBeenCalledOnce();
		expect((await listRequestFilings(db, owner))[0]?.metadata).toMatchObject({
			pending: true,
			confidence: null,
			factoryProposal: true,
			suggestedProjectId: "project-docs",
		});
		expect(await db.select().from(workItems)).toHaveLength(0);
	});
	it.each([
		["UNCLEAR", 0.9],
		["NONE", 0.4],
		["project-docs", 0.4],
	] as const)(
		"keeps %s at %s pending without writing",
		async (projectId, confidence) => {
			const { db, model } = await fixture("ask");
			model.chooseProject = async () => ({
				projectId,
				confidence,
				actionable: true,
			});
			await autoFileRequests(db, model, { ...owner, now });
			expect(model).not.toHaveBeenCalled();
			expect((await listAgentSessionRequests(db, owner))[0]).toMatchObject({
				projectId: null,
				status: "waiting_on_user",
			});
			expect(await db.select().from(workItems)).toHaveLength(0);
		},
	);
	it.each(["foreign", "nan", "timeout", "missing"])(
		"retains captured requests after %s choice failure",
		async (scenario) => {
			const { db, row, model } = await fixture();
			model.chooseProject =
				scenario === "missing"
					? undefined
					: async () => {
							if (scenario === "timeout") throw new Error("timeout");
							return {
								projectId:
									scenario === "foreign" ? "foreign-project" : "project-docs",
								confidence: scenario === "nan" ? NaN : 0.9,
								actionable: true,
							};
						};
			await expect(
				autoFileRequests(db, model, { ...owner, now }),
			).rejects.toThrow();
			expect(model).not.toHaveBeenCalled();
			expect(await listRequestFilings(db, owner)).toEqual([]);
			expect((await listAgentSessionRequests(db, owner))[0]?.id).toBe(row.id);
		},
	);
	it("rejects a novel writer that tries to override the choice", async () => {
		const { db, model } = await fixture();
		model.chooseProject = async () => ({
			projectId: "NONE",
			confidence: 0.9,
			actionable: true,
		});
		await expect(
			autoFileRequests(db, model, { ...owner, now }),
		).rejects.toThrow("Novel brief cannot choose");
		expect(await listRequestFilings(db, owner)).toEqual([]);
	});
	it.each([null, "{}", "private request text"])(
		"retains requests after malformed novel brief %s",
		async (raw) => {
			const { db } = await fixture();
			const writer: LedgerModel = async () => raw;
			writer.chooseProject = async () => ({
				projectId: "NONE",
				confidence: 0.9,
				actionable: true,
			});
			await expect(
				autoFileRequests(db, writer, { ...owner, now }),
			).rejects.toThrow("candidate unavailable");
			expect(await listRequestFilings(db, owner)).toEqual([]);
		},
	);
	it("exposes only active tenant projects and the ledger owner's context", async () => {
		for (const userId of [owner.userId, "user-grace"]) {
			const { db, model } = await fixture();
			await db.insert(projects).values([
				{
					id: "foreign-project",
					orgId: "org-other",
					key: "OTHER",
					name: "Foreign",
					createdAt: now,
				},
				{
					id: "archived",
					orgId: owner.organizationId,
					key: "OLD",
					name: "Old",
					status: "archived",
					createdAt: now,
				},
			]);
			await db.insert(workAgentSessions).values({
				id: "session",
				organizationId: owner.organizationId,
				userId,
				harness: "codex",
				sessionKey: "session-example",
				projectId: "project-docs",
				label: "Installation",
				state: "working",
				stateSince: now,
				lastEventAt: now,
			});
			model.chooseProject = async ({ context, projectIds }) => {
				expect(projectIds).toEqual(["project-docs"]);
				const input = JSON.parse(context);
				expect(input.sourceSession?.projectId ?? null).toBe(
					userId === owner.userId ? "project-docs" : null,
				);
				return { projectId: "project-docs", confidence: 0.9, actionable: true };
			};
			await autoFileRequests(db, model, { ...owner, now });
		}
	});
	it("retains all 85 multilingual live project choices", async () => {
		const { db, model } = await fixture();
		for (let i = 0; i < 84; i++)
			await db.insert(projects).values({
				id: `project-${i}`,
				orgId: owner.organizationId,
				key: `P${i}`,
				name: `Fictional project ${i}`,
				description: "Mehrsprachige Beschreibung 🐇 ".repeat(200),
				createdAt: now,
			});
		model.chooseProject = async ({ context, projectIds }) => {
			expect(projectIds).toHaveLength(85);
			expect(JSON.parse(context).projects).toHaveLength(85);
			expect(new TextEncoder().encode(context).byteLength).toBeLessThanOrEqual(
				18000,
			);
			return { projectId: "project-docs", confidence: 0.9, actionable: true };
		};
		await autoFileRequests(db, model, { ...owner, now });
		expect(model).not.toHaveBeenCalled();
	});
	it("reuses matching Work and rejects foreign or conflicting Work", async () => {
		for (const scenario of [
			"matching",
			"unprojected",
			"foreign",
			"conflicting",
		]) {
			const { db, row, model } = await fixture();
			await db.insert(workItems).values({
				id: "existing",
				orgId: scenario === "foreign" ? "org-other" : owner.organizationId,
				title: "Installation",
				projectId:
					scenario === "unprojected"
						? null
						: scenario === "conflicting"
							? "other-project"
							: "project-docs",
				disposition: "accepted",
				createdAt: now,
			});
			model.chooseProject = async () => ({
				projectId: "project-docs",
				confidence: 0.9,
				actionable: true,
				workItemId: "existing",
			});
			if (["foreign", "conflicting"].includes(scenario))
				await expect(
					autoFileRequests(db, model, { ...owner, now }),
				).rejects.toThrow("Unknown filing Work");
			else {
				await autoFileRequests(db, model, { ...owner, now });
				expect(
					(await listRequestFilings(db, owner))[0]?.metadata?.workItemId,
				).toBe("existing");
				expect(
					await getWorkItemBySourceIntentId(db, {
						orgId: owner.organizationId,
						sourceIntentId: `request-filing:${row.id}`,
					}),
				).toBeNull();
			}
		}
	});
	it("feeds corrections into the next choice and measures the cohort", async () => {
		const { db, model } = await fixture();
		await autoFileRequests(db, model, { ...owner, now });
		const [row] = await listAgentSessionRequests(db, owner);
		await recordRequestFiling(db, {
			...owner,
			row: row!,
			projectId: null,
			by: "correction",
			confidence: 1,
			reason: "Undo",
			now: "2026-10-10T10:01:00.000Z",
		});
		model.chooseProject = async ({ context }) => {
			expect(JSON.parse(context).corrections[0]).toEqual([
				row!.text,
				null,
				"project-docs",
			]);
			return { projectId: "UNCLEAR", confidence: 0.9, actionable: false };
		};
		await autoFileRequests(db, model, {
			...owner,
			now: "2026-10-10T10:02:00.000Z",
		});
		expect(
			await weeklyFilingDigest(db, owner, "2026-10-10T10:03:00.000Z"),
		).toMatchObject({ total: 1, corrected: 1, correctionRate: 1 });
	});
	it.each([0.4, 0.9])(
		"recovers committed filing Work after interruption at %s",
		async (confidence) => {
			const { db, row, model } = await fixture();
			await recordRequestFiling(db, {
				...owner,
				row,
				projectId: "project-docs",
				by: "auto",
				confidence,
				reason: "Fits",
				actionable: true,
				now,
			});
			await autoFileRequests(db, model, { ...owner, now });
			expect(model.chooseProject).not.toHaveBeenCalled();
			const work = await getWorkItemBySourceIntentId(db, {
				orgId: owner.organizationId,
				sourceIntentId: `request-filing:${row.id}`,
			});
			expect(!!work).toBe(confidence >= 0.8);
		},
	);
});

it("moves and undoes generated proposals with their filing, while accepted Work retains its project", async () => {
	const { db, model } = await fixture();
	await autoFileRequests(db, model, { ...owner, now });
	let [row] = await listAgentSessionRequests(db, owner);
	const sourceIntentId = `request-filing:${row!.id}`;
	await db.insert(projects).values({
		id: "project-tools",
		orgId: owner.organizationId,
		key: "TOOLS",
		name: "Developer tools",
		createdAt: now,
	});
	await recordRequestFiling(db, {
		...owner,
		row: row!,
		projectId: "project-tools",
		by: "correction",
		confidence: 1,
		reason: "Developer tools fits",
		now: "2026-10-10T10:01:00.000Z",
	});
	let work = await getWorkItemBySourceIntentId(db, {
		orgId: owner.organizationId,
		sourceIntentId,
	});
	expect(work?.projectId).toBe("project-tools");
	expect(await db.select().from(workEvents)).toHaveLength(1);
	[row] = await listAgentSessionRequests(db, owner);
	await recordRequestFiling(db, {
		...owner,
		row: row!,
		projectId: null,
		by: "correction",
		confidence: 1,
		reason: "Undo",
		now: "2026-10-10T10:02:00.000Z",
	});
	expect(
		(
			await getWorkItemBySourceIntentId(db, {
				orgId: owner.organizationId,
				sourceIntentId,
			})
		)?.projectId,
	).toBeNull();
	await autoFileRequests(db, model, {
		...owner,
		now: "2026-10-10T10:03:00.000Z",
	});
	work = await getWorkItemBySourceIntentId(db, {
		orgId: owner.organizationId,
		sourceIntentId,
	});
	expect(work?.projectId).toBe("project-docs");
	await db
		.update(workItems)
		.set({ disposition: "accepted" })
		.where(eq(workItems.id, work!.id));
	[row] = await listAgentSessionRequests(db, owner);
	await recordRequestFiling(db, {
		...owner,
		row: row!,
		projectId: "project-tools",
		by: "correction",
		confidence: 1,
		reason: "Move request",
		now: "2026-10-10T10:04:00.000Z",
	});
	expect(
		(
			await getWorkItemBySourceIntentId(db, {
				orgId: owner.organizationId,
				sourceIntentId,
			})
		)?.projectId,
	).toBe("project-docs");
});

it("creates proposed Work for an actionable question without marking it answered", async () => {
	const { db, row, model } = await fixture("question");
	await autoFileRequests(db, model, { ...owner, now });
	expect(
		(
			await getWorkItemBySourceIntentId(db, {
				orgId: owner.organizationId,
				sourceIntentId: `request-filing:${row.id}`,
			})
		)?.disposition,
	).toBe("proposed");
	expect((await listAgentSessionRequests(db, owner))[0]?.status).toBe("open");
});

it("suppresses novel briefs when the choice found existing Work", async () => {
	const { db, model } = await fixture();
	await db.insert(workItems).values({
		id: "existing",
		orgId: owner.organizationId,
		title: "Installation",
		projectId: "project-docs",
		disposition: "accepted",
		createdAt: now,
	});
	model.chooseProject = async () => ({
		projectId: "NONE",
		confidence: 0.9,
		actionable: true,
		workItemId: "existing",
	});
	await autoFileRequests(db, model, { ...owner, now });
	expect(model).not.toHaveBeenCalled();
	expect((await listRequestFilings(db, owner))[0]?.metadata).toMatchObject({
		workItemId: "existing",
		factoryProposal: false,
		pending: true,
	});
});

it("retains requests when the live project inventory may be truncated", async () => {
	const { db, row, model } = await fixture();
	for (let i = 0; i < 200; i++)
		await db.insert(projects).values({
			id: `extra-${i}`,
			orgId: owner.organizationId,
			key: `P${i}`,
			name: `Project ${i}`,
			createdAt: now,
		});
	await expect(autoFileRequests(db, model, { ...owner, now })).rejects.toThrow(
		"inventory may be truncated",
	);
	expect(model.chooseProject).not.toHaveBeenCalled();
	expect((await listAgentSessionRequests(db, owner))[0]?.id).toBe(row.id);
	expect(await listRequestFilings(db, owner)).toEqual([]);
});
