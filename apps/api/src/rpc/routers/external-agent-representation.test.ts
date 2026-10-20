import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { apiKeys } from "@tedix/db/schema/api-keys";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import * as agentTables from "@tedix/db/schema/external-agent-identity";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import { createExternalAgentPrincipal } from "@tedix/db/queries/external-agent-identity/principals";
import {
	resolveCanonicalWorkParties,
	isSameCanonicalParty,
} from "@tedix/db/queries/external-agent-identity/canonical-party";
import { recordExternalAgentReviewEvidence } from "@tedix/db/queries/external-agent-identity/review-evidence";
import type { BaseContext } from "../orpc";
import { externalAgentIdentityContractRouter } from "./external-agent-identity";
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000099";
const NOW = "2030-01-01T00:00:00.000Z";
let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbClient>;
let statements: string[];
beforeEach(async () => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		[apiKeys, organizationMembers, ...Object.values(agentTables)]
			.flatMap(tableDdl)
			.join(";"),
	);
	statements = [];
	db = createDbClient(
		createD1Facade(sqlite, { onPrepare: (query) => statements.push(query) }),
	);
	await db.insert(organizationMembers).values({
		id: "human-member",
		organizationId: ORG,
		userId: "canonical-human",
		descopeUserId: "different-provider-subject",
		email: "human@example.test",
		kind: "human",
		role: "member",
		status: "active",
	});
	await db.insert(apiKeys).values(
		[1, 2].map((i) => ({
			id: `fixture-key-${i}`,
			organizationId: ORG,
			name: `Fixture${i}`,
			keyHash: `fictional-hash-${i}`,
			keyPreview: "fixture",
			status: "active" as const,
			expiresAt: "2030-01-02T00:00:00.000Z",
		})),
	);
});
afterEach(() => sqlite.close());
function client(role = "admin", agentKey = false) {
	return createRouterClient(externalAgentIdentityContractRouter, {
		context: {
			authType: agentKey ? "apikey" : "user",
			user: agentKey ? undefined : { sub: "fixture-admin" },
			userRole: agentKey ? undefined : role,
			apiKey: agentKey
				? {
						id: "fixture-key-1",
						name: "Fixture",
						organizationId: ORG,
						scopes: ["mcp:work.read"],
					}
				: undefined,
			organizationId: ORG,
			db,
			env: { ENVIRONMENT: "test" },
			headers: new Headers(),
			rateLimiter: { limit: async () => ({ success: true }) },
			url: new URL("https://api.tedix.test/rpc"),
			waitUntil: () => {},
		} as unknown as BaseContext,
	});
}
function input(i = 1, representedUserId = "canonical-human") {
	return {
		organizationId: ORG,
		key: `fixture-agent-${i}`,
		displayName: `Fixture agent ${i}`,
		credentialBindingType: "api_key" as const,
		credentialBindingId: `fixture-key-${i}`,
		metadata: {
			platform: "codex-cloud" as const,
			representedUserId,
			allowedScopes: ["mcp:work.read"],
		},
	};
}
async function session(principalId: string, i: number) {
	const id = `00000000-0000-4000-8000-00000000000${i + 2}`;
	await db.insert(agentTables.externalAgentSessions).values({
		id,
		organizationId: ORG,
		principalId,
		externalSessionKey: `codex:fixture-${i}`,
		harness: "codex",
		harnessVersion: "1",
		modelProvider: "fixture",
		modelId: "fixture",
		modelVersion: "1",
		identitySource: "native",
		creditEligible: true,
		startedAt: NOW,
		lastSeenAt: NOW,
	});
	return id;
}
describe("represented external-agent principal", () => {
	it("accepts a canonical active human without creating a member or changing authority", async () => {
		const actor = await client().createPrincipal(input());
		expect(actor.metadata).toMatchObject({
			representedUserId: "canonical-human",
			platform: "codex-cloud",
		});
		expect(
			sqlite
				.prepare("SELECT count(*) AS total FROM organization_members")
				.get(),
		).toMatchObject({ total: 1 });
		expect(await client().createPrincipal(input())).toEqual(actor);
		await expect(
			client("member").createPrincipal(input(2)),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it.each([
		"viewer",
		"inactive",
		"other-org",
		"nonhuman",
		"provider-subject",
		"missing",
	])("rejects invalid representation: %s", async (mode) => {
		if (mode === "viewer")
			sqlite.exec("UPDATE organization_members SET role='viewer'");
		if (mode === "inactive")
			sqlite.exec("UPDATE organization_members SET status='deactivated'");
		if (mode === "other-org")
			sqlite
				.prepare("UPDATE organization_members SET organization_id=?")
				.run(OTHER);
		if (mode === "nonhuman")
			sqlite.exec("UPDATE organization_members SET kind='external_agent'");
		const target =
			mode === "provider-subject"
				? "different-provider-subject"
				: mode === "missing"
					? "missing-user"
					: "canonical-human";
		await expect(
			client().createPrincipal(input(1, target)),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			sqlite
				.prepare("SELECT count(*) AS total FROM external_agent_principals")
				.get(),
		).toMatchObject({ total: 0 });
	});
	it("validates representation at the database insertion boundary", async () => {
		sqlite.exec("UPDATE organization_members SET role='viewer'");
		await expect(
			createExternalAgentPrincipal(db, {
				id: crypto.randomUUID(),
				...input(),
				createdByType: "user",
				createdById: "fixture-admin",
				createdAt: NOW,
			}),
		).rejects.toThrow("active human");
	});
	it("collapses siblings and their human in one bounded tenant-scoped query, regardless of status", async () => {
		const a = await client().createPrincipal(input());
		const b = await client().createPrincipal(input(2));
		sqlite.exec("UPDATE external_agent_principals SET status='retired'");
		const left = { type: "external_agent", id: a.id };
		const right = { type: "external_agent", id: b.id };
		statements = [];
		const parties = await resolveCanonicalWorkParties(db, {
			organizationId: ORG,
			parties: [left, right, { type: "user", id: "canonical-human" }],
		});
		expect(statements).toHaveLength(1);
		expect(isSameCanonicalParty(parties, left, right)).toBe(true);
		expect(
			isSameCanonicalParty(parties, left, {
				type: "user",
				id: "canonical-human",
			}),
		).toBe(true);
		expect(
			isSameCanonicalParty(
				await resolveCanonicalWorkParties(db, {
					organizationId: OTHER,
					parties: [left, right],
				}),
				left,
				right,
			),
		).toBe(false);
		await expect(
			resolveCanonicalWorkParties(db, {
				organizationId: ORG,
				parties: Array.from({ length: 51 }, (_, i) => ({
					type: "external_agent",
					id: `principal-${i}`,
				})),
			}),
		).rejects.toThrow("capped at 50");
	});
	it("rejects a sibling agent's review of the represented user's execution", async () => {
		const a = await client().createPrincipal(input());
		const b = await client().createPrincipal(input(2));
		const aSession = await session(a.id, 1);
		const bSession = await session(b.id, 2);
		const proof = crypto.randomUUID();
		await db.insert(agentTables.externalAgentAttributions).values({
			id: proof,
			organizationId: ORG,
			principalId: a.id,
			sessionId: aSession,
			targetType: "commit",
			targetId: "fictional-sha",
			role: "executor",
			metadata: {
				provenanceCertification: { source: "work_item_attempt" },
				reputationContext: {
					taskFamily: "fixture",
					repositoryKey: "fixture/repo",
					repositoryVersion: "fictional-sha",
					riskLevel: "low",
					environment: "test",
				},
			},
			occurredAt: NOW,
		});
		await expect(
			recordExternalAgentReviewEvidence(db, {
				id: crypto.randomUUID(),
				organizationId: ORG,
				executionAttributionId: proof,
				reviewerPrincipalType: "external_agent",
				reviewerPrincipalId: b.id,
				reviewerSessionId: bSession,
				context: {
					taskFamily: "fixture",
					repositoryKey: "fixture/repo",
					repositoryVersion: "fictional-sha",
					riskLevel: "low",
					environment: "test",
				},
				outcome: "success",
				score: 1,
				policyViolationSeverity: 0,
				reviewMethod: "fixture",
				evidenceRefs: ["output://fictional-proof"],
				occurredAt: NOW,
			}),
		).rejects.toMatchObject({
			reason: "review_conflict",
			message: expect.stringContaining("own party"),
		});
	});
	it("projects latest-session activity and enrollment fields while preserving legacy owner-host parties", async () => {
		const a = await client().createPrincipal(input());
		await session(a.id, 1);
		await db.insert(agentTables.externalAgentSessions).values({
			id: crypto.randomUUID(),
			organizationId: ORG,
			principalId: a.id,
			externalSessionKey: "codex:latest",
			harness: "codex",
			harnessVersion: "1",
			modelProvider: "fixture",
			modelId: "fixture",
			modelVersion: "1",
			identitySource: "native",
			startedAt: "2030-01-01T00:01:00.000Z",
			lastSeenAt: "2030-01-01T00:02:00.000Z",
		});
		const owner = await createExternalAgentPrincipal(db, {
			id: crypto.randomUUID(),
			organizationId: ORG,
			key: "legacy-owner",
			displayName: "Owner host",
			credentialBindingType: "owner_user",
			credentialBindingId: "canonical-human",
			createdByType: "user",
			createdById: "canonical-human",
			createdAt: NOW,
		});
		const rows = await client().listPrincipals({
			organizationId: ORG,
			limit: 100,
		});
		expect(rows.find((row) => row.id === a.id)).toMatchObject({
			platform: "codex-cloud",
			representedUserId: "canonical-human",
			allowedScopes: ["mcp:work.read"],
			expiresAt: "2030-01-02T00:00:00.000Z",
			lastSeenAt: "2030-01-01T00:02:00.000Z",
		});
		expect(rows.find((row) => row.id === owner.id)).toMatchObject({
			platform: null,
			representedUserId: null,
			allowedScopes: null,
			expiresAt: null,
			lastSeenAt: null,
		});
		const parties = await resolveCanonicalWorkParties(db, {
			organizationId: ORG,
			parties: [
				{ type: "external_agent", id: a.id },
				{ type: "external_agent", id: owner.id },
			],
		});
		expect(
			isSameCanonicalParty(
				parties,
				{ type: "external_agent", id: a.id },
				{ type: "external_agent", id: owner.id },
			),
		).toBe(true);
	});
	it("grants no represented user's governance authority to an agent", async () => {
		sqlite.exec("UPDATE organization_members SET role='owner'");
		await client().createPrincipal(input());
		await expect(
			client("owner", true).createPrincipal(input(2)),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("does not project another organization's key or session details", async () => {
		const actor = await client().createPrincipal(input());
		await session(actor.id, 1);
		sqlite.prepare("UPDATE api_keys SET organization_id=?").run(OTHER);
		sqlite
			.prepare("UPDATE external_agent_sessions SET organization_id=?")
			.run(OTHER);
		expect(
			(await client().listPrincipals({ organizationId: ORG, limit: 100 }))[0],
		).toMatchObject({ id: actor.id, expiresAt: null, lastSeenAt: null });
	});
});
