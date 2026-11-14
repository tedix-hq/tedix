import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { externalAgentPrincipals } from "@tedix/db/schema/external-agent-identity";
import { projects } from "@tedix/db/schema/projects";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { externalAgentIdentityContractRouter } from "./external-agent-identity";
import type { BaseContext } from "../orpc";

const ORG = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL = "00000000-0000-4000-8000-000000000002";
let sqlite: DatabaseSync;
let context: BaseContext;
beforeEach(async () => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			externalAgentPrincipals,
			auditEvents,
			organizationMembers,
			projects,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(externalAgentPrincipals).values({
		id: PRINCIPAL,
		organizationId: ORG,
		key: "example-agent",
		displayName: "Example agent",
		status: "active",
		credentialBindingType: "api_key",
		credentialBindingId: "key",
		createdByType: "user",
		createdById: "owner",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		metadata: { unrelated: "preserved" },
	});
	await db.insert(organizationMembers).values({
		id: "member",
		organizationId: ORG,
		userId: "owner",
		descopeUserId: "owner",
		email: "owner@example.test",
		role: "owner",
		status: "active",
	});
	context = {
		db,
		authType: "user",
		user: { sub: "owner" },
		userRole: "owner",
		organizationId: ORG,
		headers: new Headers(),
		env: { ENVIRONMENT: "test" },
		url: new URL("https://api.example.test/rpc"),
		rateLimiter: { limit: async () => ({ success: true }) },
		waitUntil: () => {},
	} as unknown as BaseContext;
});
afterEach(() => sqlite.close());
const change = (
	grant: {
		scope: "organization";
		actions: ("specification" | "cancellation")[];
	} | null,
	principalId = PRINCIPAL,
) =>
	createRouterClient(externalAgentIdentityContractRouter, {
		context,
	}).setWorkManagement({ principalId, grant });

it.each(["owner", "admin"])(
	"lets an active %s grant and revoke with atomic audit and preserved metadata",
	async (role) => {
		sqlite.prepare("UPDATE organization_members SET role=?").run(role);
		const grant = {
			scope: "organization" as const,
			actions: ["specification", "cancellation"] as (
				| "specification"
				| "cancellation"
			)[],
		};
		expect(await change(grant)).toMatchObject({
			metadata: { unrelated: "preserved", workManagement: grant },
		});
		const revoked = await change(null);
		expect(revoked.metadata).toEqual({ unrelated: "preserved" });
		const rows = sqlite
			.prepare(
				"SELECT actor_type, actor_id, metadata FROM audit_events ORDER BY rowid",
			)
			.all();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ actor_type: "user", actor_id: "owner" });
		expect(JSON.parse(rows[1]!.metadata as string)).toEqual({
			previousGrant: grant,
			grant: null,
		});
	},
);
it.each(["member", "viewer", "inactive"])(
	"rejects %s despite stale token owner role",
	async (state) => {
		if (state === "inactive")
			sqlite.exec("UPDATE organization_members SET status='suspended'");
		else sqlite.prepare("UPDATE organization_members SET role=?").run(state);
		await expect(change(null)).rejects.toMatchObject({ code: "FORBIDDEN" });
	},
);
it("rejects an agent using owner OAuth and wildcard machine credentials", async () => {
	context.externalAgentPrincipalId = PRINCIPAL;
	await expect(change(null)).rejects.toMatchObject({ code: "FORBIDDEN" });
	context.externalAgentPrincipalId = undefined;
	context.authType = "apikey";
	context.apiKey = {
		id: "key",
		name: "machine",
		organizationId: ORG,
		scopes: ["*"],
	};
	await expect(change(null)).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("does not touch another organization's principal or audit", async () => {
	sqlite.exec(
		"UPDATE external_agent_principals SET organization_id='other-org'",
	);
	await expect(change(null)).rejects.toMatchObject({ code: "NOT_FOUND" });
	expect(
		sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
	).toMatchObject({ n: 0 });
});
it("rolls back grant when audit persistence fails", async () => {
	sqlite.exec(
		"CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
	);
	await expect(
		change({ scope: "organization", actions: ["specification"] }),
	).rejects.toThrow();
	expect(
		sqlite.prepare("SELECT metadata FROM external_agent_principals").get(),
	).toMatchObject({ metadata: JSON.stringify({ unrelated: "preserved" }) });
});

it("accepts a named project only in the owner's organization", async () => {
	const projectId = "00000000-0000-4000-8000-000000000003";
	await context.db.insert(projects).values({
		id: projectId,
		orgId: ORG,
		key: "EXAMPLE",
		name: "Example",
		createdAt: new Date().toISOString(),
	});
	const client = createRouterClient(externalAgentIdentityContractRouter, {
		context,
	});
	const input = {
		organizationId: ORG,
		principalId: PRINCIPAL,
		grant: {
			scope: "project" as const,
			projectId,
			actions: ["specification" as const],
		},
	};
	expect(await client.setWorkManagement(input)).toMatchObject({
		metadata: { workManagement: input.grant },
	});
	sqlite.exec("UPDATE projects SET org_id='other-org'");
	await expect(client.setWorkManagement(input)).rejects.toMatchObject({
		code: "NOT_FOUND",
	});
});

it("rolls back the audit when the principal update fails", async () => {
	sqlite.exec(
		"CREATE TRIGGER fail_update BEFORE UPDATE ON external_agent_principals BEGIN SELECT RAISE(ABORT, 'update unavailable'); END",
	);
	await expect(
		change({ scope: "organization", actions: ["specification"] }),
	).rejects.toThrow();
	expect(
		sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
	).toMatchObject({ n: 0 });
});
