import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "../../schema/external-agent-identity";
import { organizationMembers } from "../../schema/organization-members";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
import { workCases, workMilestones } from "../../schema/work-factory";
import { workItems } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	requireActivePrincipal,
	requireExternalSession,
	requireMilestone,
	requireProject,
	requireWorkCase,
	requireWorkItem,
	WorkControlError,
} from "./factory-validation";

const ORG = "org-fixture";
const OTHER_ORG = "org-other";
const NOW = "2026-10-20T12:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizationMembers,
			tedis,
			externalAgentPrincipals,
			externalAgentSessions,
			workItems,
			projects,
			workCases,
			workMilestones,
		),
	);
	return createDbQueryClient(createD1Facade(sqlite));
}

async function expectControlError(
	result: Promise<unknown>,
	code: WorkControlError["code"],
) {
	await expect(result).rejects.toBeInstanceOf(WorkControlError);
	await expect(result).rejects.toMatchObject({
		name: "WorkControlError",
		code,
	});
}

describe("WorkControlError", () => {
	it.each([
		"NOT_FOUND",
		"CONFLICT",
		"INVALID_PRINCIPAL",
		"INVALID_TRANSITION",
		"NOT_ELIGIBLE",
		"CAPACITY_EXHAUSTED",
		"BUDGET_EXHAUSTED",
	] as const)("preserves the %s code and message", (code) => {
		const error = new WorkControlError(code, "fixture reason");
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("WorkControlError");
		expect(error.code).toBe(code);
		expect(error.message).toBe(`${code}: fixture reason`);
	});
});

describe("requireActivePrincipal", () => {
	for (const type of ["user", "tedi", "external_agent"] as const) {
		describe(type, () => {
			it.each(["active", "missing", "wrong organization", "inactive"] as const)(
				"checks %s principal",
				async (scenario) => {
					const db = setup();
					const organizationId =
						scenario === "wrong organization" ? OTHER_ORG : ORG;
					if (scenario !== "missing") {
						if (type === "user")
							await db.insert(organizationMembers).values({
								id: "membership",
								organizationId,
								userId: "principal",
								descopeUserId: "provider-subject",
								email: "member@example.test",
								status: scenario === "inactive" ? "deactivated" : "active",
							});
						else if (type === "tedi")
							await db.insert(tedis).values({
								id: "principal",
								organizationId,
								name: "Fixture worker",
								slug: "fixture-worker",
								retiredAt: scenario === "inactive" ? NOW : null,
							});
						else
							await db.insert(externalAgentPrincipals).values({
								id: "principal",
								organizationId,
								key: "fixture-executor",
								displayName: "Fixture executor",
								status: scenario === "inactive" ? "suspended" : "active",
								credentialBindingType: "api_key",
								credentialBindingId: "fixture-binding",
								createdByType: "user",
								createdById: "fixture-owner",
							});
					}
					const result = requireActivePrincipal(db, {
						orgId: ORG,
						type,
						id: "principal",
					});
					if (scenario === "active")
						await expect(result).resolves.toBeUndefined();
					else await expectControlError(result, "INVALID_PRINCIPAL");
				},
			);
		});
	}

	it("rejects invited members and provider subjects used as canonical ids", async () => {
		const db = setup();
		await db.insert(organizationMembers).values({
			id: "membership",
			organizationId: ORG,
			userId: "canonical-user",
			descopeUserId: "provider-subject",
			email: "member@example.test",
			status: "invited",
		});
		await expectControlError(
			requireActivePrincipal(db, {
				orgId: ORG,
				type: "user",
				id: "canonical-user",
			}),
			"INVALID_PRINCIPAL",
		);
		await db.insert(organizationMembers).values({
			id: "active-membership",
			organizationId: ORG,
			userId: "active-user",
			descopeUserId: "active-provider-subject",
			email: "active@example.test",
			status: "active",
		});
		await expectControlError(
			requireActivePrincipal(db, {
				orgId: ORG,
				type: "user",
				id: "active-provider-subject",
			}),
			"INVALID_PRINCIPAL",
		);
	});

	it("rejects retired external-agent principals", async () => {
		const db = setup();
		await db.insert(externalAgentPrincipals).values({
			id: "principal",
			organizationId: ORG,
			key: "fixture-executor",
			displayName: "Fixture executor",
			status: "retired",
			credentialBindingType: "api_key",
			credentialBindingId: "fixture-binding",
			createdByType: "user",
			createdById: "fixture-owner",
		});
		await expectControlError(
			requireActivePrincipal(db, {
				orgId: ORG,
				type: "external_agent",
				id: "principal",
			}),
			"INVALID_PRINCIPAL",
		);
	});

	it.each([ORG, OTHER_ORG])(
		"accepts the canonical system id in %s without a database principal",
		async (orgId) => {
			await expect(
				requireActivePrincipal(setup(), { orgId, type: "system", id: "tedix" }),
			).resolves.toBeUndefined();
		},
	);

	it.each(["", "other-system"])(
		"rejects noncanonical system id %s",
		async (id) => {
			await expectControlError(
				requireActivePrincipal(setup(), { orgId: ORG, type: "system", id }),
				"INVALID_PRINCIPAL",
			);
		},
	);
});

describe("requireExternalSession", () => {
	it.each([
		"active",
		"missing",
		"wrong organization",
		"wrong principal",
		"wrong session id",
		"wrong session key",
		"ended",
	] as const)("checks %s session fence", async (scenario) => {
		const db = setup();
		if (scenario !== "missing")
			await db.insert(externalAgentSessions).values({
				id: "session",
				organizationId: ORG,
				principalId: "principal",
				externalSessionKey: "fixture:session",
				harness: "fixture",
				harnessVersion: "1.0.0",
				modelProvider: "fixture",
				modelId: "fixture-model",
				modelVersion: "1.0.0",
				identitySource: "native",
				startedAt: NOW,
				lastSeenAt: NOW,
				status: scenario === "ended" ? "ended" : "active",
				endedAt: scenario === "ended" ? NOW : null,
			});
		const result = requireExternalSession(db, {
			orgId: scenario === "wrong organization" ? OTHER_ORG : ORG,
			principalId:
				scenario === "wrong principal" ? "other-principal" : "principal",
			sessionId: scenario === "wrong session id" ? "other-session" : "session",
			externalSessionKey:
				scenario === "wrong session key" ? "fixture:other" : "fixture:session",
		});
		if (scenario === "active") await expect(result).resolves.toBeUndefined();
		else await expectControlError(result, "INVALID_PRINCIPAL");
	});
});

describe("organization-scoped entity requirements", () => {
	const lookups = [
		{
			name: "Work Item",
			require: requireWorkItem,
			seed: async (db: ReturnType<typeof setup>, inactive: boolean) => {
				await db.insert(workItems).values({
					id: "entity",
					orgId: ORG,
					title: "Fixture work",
					createdAt: NOW,
					disposition: inactive ? "cancelled" : "accepted",
					cancelledAt: inactive ? NOW : null,
				});
			},
		},
		{
			name: "project",
			require: requireProject,
			seed: async (db: ReturnType<typeof setup>, inactive: boolean) => {
				await db.insert(projects).values({
					id: "entity",
					orgId: ORG,
					key: "FIXTURE",
					name: "Fixture project",
					createdAt: NOW,
					status: inactive ? "archived" : "active",
					archivedAt: inactive ? NOW : null,
				});
			},
		},
		{
			name: "case",
			require: requireWorkCase,
			seed: async (db: ReturnType<typeof setup>, inactive: boolean) => {
				await db.insert(workCases).values({
					id: "entity",
					orgId: ORG,
					title: "Fixture case",
					kind: "fixture",
					accountableOwnerType: "system",
					accountableOwnerId: "tedix",
					openedAt: NOW,
					createdAt: NOW,
					stage: inactive ? "closed" : "executing",
					closedAt: inactive ? NOW : null,
				});
			},
		},
		{
			name: "milestone",
			require: requireMilestone,
			seed: async (db: ReturnType<typeof setup>, inactive: boolean) => {
				await db.insert(workMilestones).values({
					id: "entity",
					orgId: ORG,
					projectId: "fixture-project",
					title: "Fixture milestone",
					accountableOwnerType: "system",
					accountableOwnerId: "tedix",
					createdAt: NOW,
					status: inactive ? "cancelled" : "active",
					cancelledAt: inactive ? NOW : null,
				});
			},
		},
	];

	for (const lookup of lookups) {
		describe(lookup.name, () => {
			it("returns the complete matching row", async () => {
				const db = setup();
				await lookup.seed(db, false);
				expect(await lookup.require(db, ORG, "entity")).toMatchObject({
					id: "entity",
					orgId: ORG,
					createdAt: NOW,
				});
			});
			it("rejects a missing id with NOT_FOUND", async () => {
				const db = setup();
				await lookup.seed(db, false);
				await expectControlError(
					lookup.require(db, ORG, "missing"),
					"NOT_FOUND",
				);
			});
			it("rejects an existing row from another organization with NOT_FOUND", async () => {
				const db = setup();
				await lookup.seed(db, false);
				await expectControlError(
					lookup.require(db, OTHER_ORG, "entity"),
					"NOT_FOUND",
				);
			});
			it("returns inactive rows because lifecycle admission belongs to callers", async () => {
				const db = setup();
				await lookup.seed(db, true);
				const row = await lookup.require(db, ORG, "entity");
				expect(row).toMatchObject({ id: "entity", orgId: ORG });
				if ("disposition" in row) expect(row.disposition).toBe("cancelled");
				else if ("stage" in row) expect(row.stage).toBe("closed");
				else
					expect(row.status).toBe(
						lookup.name === "project" ? "archived" : "cancelled",
					);
			});
		});
	}
});
