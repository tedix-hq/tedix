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
	model.scoreProjectFit = vi.fn(async () => 0.9);
	return { db, row: row!, model };
}

describe("automatic filing", () => {
	it("uses fit confidence, creates proposed Work once, and preserves open status", async () => {
		const { db, row, model } = await fixture();
		await autoFileRequests(db, model, { ...owner, now });
		await autoFileRequests(db, model, { ...owner, now });
		expect((await listAgentSessionRequests(db, owner))[0]?.projectId).toBe(
			"project-docs",
		);
		expect(await listRequestFilings(db, owner)).toHaveLength(1);
		const work = await getWorkItemBySourceIntentId(db, {
			orgId: owner.organizationId,
			sourceIntentId: `request-filing:${row.id}`,
		});
		expect(work?.disposition).toBe("proposed");
		expect(model.scoreProjectFit).toHaveBeenCalledOnce();
	});
	it("files uncertain asks to marked new containers while leaving their answer pending", async () => {
		const { db, row, model } = await fixture("ask");
		model.scoreProjectFit = async () => 0.4;
		await autoFileRequests(db, model, { ...owner, now });
		const [filed] = await listAgentSessionRequests(db, owner);
		expect(filed?.projectId).not.toBe("project-docs");
		expect(filed?.status).toBe("waiting_on_user");
		const [project] = await db
			.select()
			.from(projects)
			.where(eq(projects.id, filed!.projectId!));
		expect(project?.metadata?.autoCreated).toBe(true);
		expect(
			await getWorkItemBySourceIntentId(db, {
				orgId: owner.organizationId,
				sourceIntentId: `request-filing:${row.id}`,
			}),
		).toBeNull();
	});
	it("rejects malformed output, unknown projects and invalid fit scores without a filing", async () => {
		for (const scenario of [
			"invalid-json",
			"foreign-project",
			"invalid-score",
		]) {
			const { db, model } = await fixture();
			const invalid: LedgerModel = async () =>
				scenario === "invalid-json"
					? "{}"
					: JSON.stringify({
							...pick,
							projectId:
								scenario === "foreign-project"
									? "foreign-project"
									: pick.projectId,
						});
			invalid.scoreProjectFit = async () => Number.NaN;
			await expect(
				autoFileRequests(db, invalid, { ...owner, now }),
			).rejects.toThrow();
			expect(await listRequestFilings(db, owner)).toEqual([]);
			expect(model).not.toHaveBeenCalled();
		}
	});
	it("accepts an entire fenced JSON response and still validates its destination", async () => {
		for (const projectId of ["project-docs", "foreign-project"]) {
			const { db, model } = await fixture();
			const fenced: LedgerModel = async () =>
				`\`\`\`json\n${JSON.stringify({ ...pick, projectId })}\n\`\`\``;
			fenced.scoreProjectFit = model.scoreProjectFit;
			if (projectId === "foreign-project") {
				await expect(
					autoFileRequests(db, fenced, { ...owner, now }),
				).rejects.toThrow("Unknown filing project");
				expect(await listRequestFilings(db, owner)).toEqual([]);
			} else {
				await autoFileRequests(db, fenced, { ...owner, now });
				expect(await listRequestFilings(db, owner)).toHaveLength(1);
			}
		}
	});
	it("distinguishes model absence and invalid fields without disclosing content", async () => {
		for (const [raw, reason] of [
			[null, "model returned no response"],
			["```json\n{}\n```", "invalid fields: projectId"],
			["{}", "invalid fields: projectId"],
			["private request text", "model returned invalid JSON"],
		] as const) {
			const { db } = await fixture();
			await expect(
				autoFileRequests(db, async () => raw, { ...owner, now }),
			).rejects.toThrow(reason);
			expect(await listRequestFilings(db, owner)).toEqual([]);
		}
	});
	it("retries proposed Work from a committed filing after an interrupted invocation", async () => {
		const { db, row, model } = await fixture("issue");
		await recordRequestFiling(db, {
			...owner,
			row,
			projectId: "project-docs",
			by: "auto",
			confidence: 0.9,
			reason: "Fits",
			actionable: true,
			now,
		});
		await autoFileRequests(db, model, { ...owner, now });
		expect(model).not.toHaveBeenCalled();
		expect(
			await getWorkItemBySourceIntentId(db, {
				orgId: owner.organizationId,
				sourceIntentId: `request-filing:${row.id}`,
			}),
		).not.toBeNull();
	});
	it("feeds corrected examples into the next pick and measures the weekly cohort", async () => {
		const { db, row, model } = await fixture("idea");
		await autoFileRequests(db, model, { ...owner, now });
		const [filed] = await listAgentSessionRequests(db, owner);
		const correctionAt = "2026-10-10T10:01:00.000Z";
		await recordRequestFiling(db, {
			...owner,
			row: filed!,
			projectId: null,
			by: "correction",
			confidence: 1,
			reason: "Belongs elsewhere",
			now: correctionAt,
		});
		const next: LedgerModel = async (_system, prompt) => {
			const input = JSON.parse(prompt);
			expect(input.columns.corrections).toEqual([
				"text",
				"projectId",
				"previousProjectId",
			]);
			expect(input.corrections[0]).toEqual([row.text, null, "project-docs"]);
			return JSON.stringify({ ...pick, projectId: null });
		};
		await autoFileRequests(db, next, {
			...owner,
			now: "2026-10-10T10:02:00.000Z",
		});
		const digest = await weeklyFilingDigest(
			db,
			owner,
			"2026-10-10T10:03:00.000Z",
		);
		expect(digest).toMatchObject({
			total: 2,
			corrected: 1,
			correctionRate: 0.5,
		});
		expect(
			await weeklyFilingDigest(
				db,
				{ ...owner, userId: "user-grace" },
				correctionAt,
			),
		).toMatchObject({ total: 0, correctionRate: null });
		expect((await listAgentSessionRequests(db, owner))[0]?.id).toBe(row.id);
	});
	it("queues filing after capture rather than waiting for model classification in ingestion", async () => {
		const { db, model } = await fixture();
		const { observeAgentSessionRequests } =
			await import("./agent-session-request-ledger");
		const observer: LedgerModel = async () =>
			JSON.stringify({ requests: [{ kind: "request", text: "Fix search" }] });
		observer.routeProjects = true;
		observer.enqueueFilings = vi.fn(async () => {});
		await observeAgentSessionRequests(db, observer, {
			...owner,
			harness: "codex",
			sessionKey: "session-two",
			message: "Fix search",
			sourceAt: now,
			repository: "example/app",
			now,
		});
		expect(observer.enqueueFilings).toHaveBeenCalledWith(owner);
		expect(model).not.toHaveBeenCalled();
	});
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

it("fits a large multilingual portfolio into the classifier window while retaining all 85 project choices", async () => {
	const { db, model } = await fixture();
	const ids = ["project-docs"];
	for (let index = 0; index < 84; index++) {
		const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
		ids.push(id);
		await db.insert(projects).values({
			id,
			orgId: owner.organizationId,
			key: `PROJECT-${index}`,
			name: `Fictional project ${index}`,
			description: "Mehrsprachige Beschreibung 🐇 ".repeat(200),
			createdAt: now,
		});
	}
	let input = "";
	const bounded: LedgerModel = async (_system, prompt) => {
		input = prompt;
		return JSON.stringify(pick);
	};
	bounded.scoreProjectFit = model.scoreProjectFit;
	await autoFileRequests(db, bounded, { ...owner, now });
	expect(new TextEncoder().encode(input).byteLength).toBeLessThanOrEqual(
		18_000,
	);
	const context = JSON.parse(input) as { projects: [string, string, string][] };
	expect(context.projects.map(([id]) => id).sort()).toEqual(ids.sort());
	expect(await listRequestFilings(db, owner)).toHaveLength(1);
});
