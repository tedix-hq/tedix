import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { externalAgentPrincipals } from "@tedix/db/schema/external-agent-identity";
import { workAttempts, workEvents } from "@tedix/db/schema/work-items";
import {
	workResourceReservations,
	workBudgetReservations,
	workInteractions,
} from "@tedix/db/schema/work-factory";
import {
	createWorkItem,
	getWorkItemById,
} from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../../orpc";
import { workItemStewardActor } from "./policy-helpers";
import {
	completeProcedure,
	settleAttemptProcedure,
	updateSpecificationProcedure,
} from "./factory-lifecycle";

const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock(
	"@tedix/db/queries/external-agent-identity/mcp-credentials",
	async (original) => ({
		...(await original<
			typeof import("@tedix/db/queries/external-agent-identity/mcp-credentials")
		>()),
		resolveAuthorizedExternalAgentMcpSession: session,
	}),
);
const id = "11111111-1111-4111-8111-111111111111";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

async function fixture({
	prefixes = ["repair:"],
	actions = ["specification", "assignment", "cancellation"],
	principalOrg = "org",
	status = "active" as "active" | "retired",
} = {}) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				externalAgentPrincipals,
				workEvents,
				workResourceReservations,
				workBudgetReservations,
				workInteractions,
			),
	);
	sqlite.exec(
		"INSERT INTO organizations(id,name,slug) VALUES('org','Org','org')",
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(externalAgentPrincipals).values({
		id: "bot",
		organizationId: principalOrg,
		key: "repair-bot",
		displayName: "Repair bot",
		status,
		credentialBindingType: "github_actions_oidc",
		credentialBindingId: "repo:example/repo:environment:repair",
		createdByType: "user",
		createdById: "owner",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		metadata: { workManagement: { sourceIntentPrefixes: prefixes, actions } },
	});
	const item = await createWorkItem(db, {
		id,
		orgId: "org",
		title: "Repair test failure",
		sourceIntentId: "repair:example",
		createdAt: new Date().toISOString(),
	});
	session.mockResolvedValue({
		session: {
			externalSessionKey: "github-actions:example",
			harness: "github-actions",
			creditEligible: false,
		},
	});
	const context = {
		db,
		organizationId: "org",
		authType: "service-binding",
		headers: new Headers(),
		externalAgentPrincipalId: "bot",
		externalAgentSessionId: "session",
		externalAgentClientRecordId: "client",
	} as BaseContext;
	const update = (input: {
		id: string;
		executor?: "codex";
		description?: string;
		riskLevel?: "low";
		expectedWorkItemVersion?: number;
	}) =>
		updateSpecificationProcedure["~orpc"].handler!({
			context,
			input,
			path: [],
			procedure: updateSpecificationProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
	return { db, sqlite, context, item, update };
}

describe("owner-granted external-agent Work management", () => {
	it.each([
		"failed",
		"expired",
		"succeeded",
		"other Work",
		"other org",
		"unadmitted",
		"wrong session",
		"missing Attempt",
		"missing settlement",
		"wrong commit",
	])(
		"checks recovered custody at settlement and completion: %s",
		async (state) => {
			const { db, sqlite, context } = await fixture();
			const now = Date.now();
			const sha = "a".repeat(40);
			const contract = { version: 1, doneLooksLike: "The fix is on main." };
			sqlite
				.prepare(
					"UPDATE work_items SET disposition='accepted', work_kind='coding', acceptance_contract=? WHERE id=?",
				)
				.run(JSON.stringify(contract), id);
			const base = {
				orgId: "org",
				workItemId: id,
				executorType: "external_agent" as const,
				executorId: "bot",
				executorSessionId: "session",
				externalSessionKey: "github-actions:example",
				heartbeatAt: new Date(now).toISOString(),
				expiresAt: new Date(now + 300000).toISOString(),
			};
			await db.insert(workAttempts).values({
				...base,
				id: "original",
				admissionId: state === "unadmitted" ? null : "original-admission",
				workItemId: state === "other Work" ? "other-work" : id,
				orgId: state === "other org" ? "other-org" : "org",
				executorId: "earlier-bot",
				executorSessionId: "earlier-session",
				externalSessionKey: "codex:earlier",
				attemptNumber: 1,
				runtimeState: "finished",
				outcome: ["failed", "expired"].includes(state)
					? (state as "failed" | "expired")
					: "succeeded",
				startedAt: new Date(now - 60000).toISOString(),
				finishedAt: new Date(now - 30000).toISOString(),
			});
			await db.insert(workAttempts).values({
				...base,
				id: "current",
				admissionId: "current-admission",
				attemptNumber: 2,
				startedAt: new Date(now).toISOString(),
				metadata: { dispatchVersion: 1 },
			});
			const metadata = {
				dispatchVersion: 1,
				laneResult: {
					outcome: "completed",
					workItemId: id,
					workVersion: 1,
					contractVersion: 1,
					outcomeText: contract.doneLooksLike,
				},
				recoveredCommits: [
					{
						commitSha: sha,
						attemptId: state === "missing Attempt" ? "missing" : "original",
						session:
							state === "wrong session" ? "codex:unadmitted" : "codex:earlier",
					},
				],
				...(state === "missing settlement"
					? {}
					: {
							settlement: {
								mode: "commit",
								commitSha: state === "wrong commit" ? "b".repeat(40) : sha,
							},
						}),
			};
			const settle = () =>
				settleAttemptProcedure["~orpc"].handler!({
					context,
					input: { id, attemptId: "current", outcome: "succeeded", metadata },
					path: [],
					procedure: settleAttemptProcedure,
					signal: undefined,
					lastEventId: undefined,
				});
			const complete = () =>
				completeProcedure["~orpc"].handler!({
					context,
					input: { id },
					path: [],
					procedure: completeProcedure,
					signal: undefined,
					lastEventId: undefined,
				});
			if (["failed", "expired", "succeeded"].includes(state)) {
				await expect(settle()).resolves.toMatchObject({
					attempt: {
						outcome: "succeeded",
						metadata: { settlement: { commitSha: sha } },
					},
				});
				await expect(complete()).resolves.toMatchObject({
					disposition: "completed",
				});
				expect(await getWorkItemById(db, id)).toMatchObject({
					disposition: "completed",
				});
			} else {
				await expect(settle()).rejects.toMatchObject({ code: "FORBIDDEN" });
				// A retained or older server receipt must not bypass the completion check.
				await db
					.update(workAttempts)
					.set({
						runtimeState: "finished",
						outcome: "succeeded",
						finishedAt: new Date(now + 1).toISOString(),
						metadata,
					})
					.where(eq(workAttempts.id, "current"));
				await expect(complete()).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(await getWorkItemById(db, id)).toMatchObject({
					disposition: "accepted",
				});
			}
		},
	);
	it("persists assignment and progress only inside the granted intent namespace", async () => {
		const { db, item, update, context } = await fixture();
		await update({
			id,
			executor: "codex",
			description: "Failure confirmed",
			expectedWorkItemVersion: item.version,
		});
		expect(await getWorkItemById(db, id)).toMatchObject({
			description: "Failure confirmed",
			metadata: { executor: "codex" },
		});
		expect(
			await workItemStewardActor(context, item, "cancellation"),
		).toMatchObject({ type: "external_agent", id: "bot" });
	});
	it.each([
		{ prefixes: ["other:"] },
		{ prefixes: [""] },
		{ actions: ["cancellation"] },
		{ principalOrg: "other" },
		{ status: "retired" as const },
	])(
		"refuses an absent, malformed, unrelated or inactive grant: %j",
		async (options) => {
			const { update } = await fixture(options);
			await expect(
				update({ id, description: "Changed" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
	it("keeps assignment separate from ordinary edits and cannot lower risk", async () => {
		const { update } = await fixture({ actions: ["specification"] });
		await expect(
			update({ id, description: "Progress" }),
		).resolves.toBeDefined();
		await expect(update({ id, executor: "codex" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(update({ id, riskLevel: "low" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it.each(["queued", "running", "waiting", "retrying"] as const)(
		"preserves %s Attempts and requires a verified session",
		async (runtimeState) => {
			const { db, update } = await fixture();
			await db.insert(workAttempts).values({
				id: "peer",
				orgId: "org",
				workItemId: id,
				executorType: "external_agent",
				executorId: "peer",
				runtimeState,
				attemptNumber: 1,
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
			});
			await expect(
				update({ id, description: "Changed" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			session.mockResolvedValue(null);
			await expect(
				update({ id, description: "Changed" }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
			});
		},
	);
	it("does not grant completion or take authority from task metadata", async () => {
		const { sqlite, context, item, update } = await fixture();
		await expect(
			workItemStewardActor(context, item, "completion"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE external_agent_principals SET metadata='{}'");
		await expect(update({ id, description: "Changed" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
