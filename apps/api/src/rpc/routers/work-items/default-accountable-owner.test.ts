/**
 * Work created without a named owner must still be acceptable: acceptance
 * refuses Work that nobody answers for, and `tedix work create` names nobody
 * unless `--owner` is passed.
 */
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "@tedix/db/schema/external-agent-identity";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { workEvents } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { createProcedure } from "./creation-reads";

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

const org = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	session.mockReset();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				organizationMembers,
				workEvents,
				tedis,
				externalAgentPrincipals,
				externalAgentSessions,
			),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${org}','Example','example');
		INSERT INTO projects(id,org_id,key,name,status,metadata,created_at) VALUES('${project}','${org}','P','Project','active','{}','2026-11-17');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m','${org}','subject','person','person@example.test','member','active');`);
	const db = createDbClient(createD1Facade(sqlite));
	const person = {
		db,
		organizationId: org,
		authType: "user",
		user: { sub: "subject" },
		headers: new Headers(),
	} as BaseContext;
	return { sqlite, db, person };
}

function principal(
	sqlite: DatabaseSync,
	binding: string,
	bindingId: string,
	metadata: Record<string, unknown> = {},
) {
	sqlite
		.prepare(
			`INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id,metadata,created_at,updated_at)
			VALUES('agent',?,'local-agent','Local agent',?,?,'user','person',?,'2026-11-17T00:00:00Z','2026-11-17T00:00:00Z')`,
		)
		.run(org, binding, bindingId, JSON.stringify(metadata));
}

/** An external agent as the MCP gateway forwards it. */
function agent(person: BaseContext): BaseContext {
	session.mockResolvedValue({
		session: {
			externalSessionKey: "claude-code:example",
			harness: "claude-code",
			creditEligible: false,
		},
	});
	return {
		...person,
		authType: "service-binding",
		serviceBindingPrincipal: "mcp-edge",
		user: undefined,
		externalAgentPrincipalId: "agent",
		externalAgentSessionId: "session",
		externalAgentClientRecordId: "client",
	} as BaseContext;
}

async function create(
	context: BaseContext,
	input: Record<string, unknown> = {},
) {
	const item = await createProcedure["~orpc"].handler!({
		context,
		input: CreateWorkItemInputSchema.parse({
			title: "Fictional task",
			projectId: project,
			workClass: "hygiene",
			purposeExceptionExpiresAt: new Date(
				Date.now() + 86_400_000,
			).toISOString(),
			...input,
		}),
		path: [],
		procedure: createProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
	return { type: item.accountableOwnerType, id: item.accountableOwnerId };
}

it("makes the person who creates Work its accountable owner", async () => {
	const { person } = fixture();
	expect(await create(person)).toEqual({ type: "user", id: "person" });
});

it("keeps an owner the caller named", async () => {
	const { person } = fixture();
	expect(
		await create(person, {
			accountableOwnerType: "tedi",
			accountableOwnerId: "cto",
		}),
	).toMatchObject({ type: "tedi", id: "cto" });
});

it("names nobody for Work a tedi proposes through Home", async () => {
	const { person } = fixture();
	const home = {
		...person,
		authType: "service-binding",
		serviceBindingPrincipal: "mcp-edge",
		user: undefined,
		descopeUserId: "subject",
		headers: new Headers({
			"X-Tedix-Kernel": "true",
			"X-Tedix-Acting-User": "subject",
		}),
	} as BaseContext;
	expect(await create(home)).toMatchObject({ type: null, id: null });
});

it("names the person who registered a local external agent", async () => {
	const { person, sqlite } = fixture();
	principal(sqlite, "aih_m2m", "client-id");
	expect(await create(agent(person))).toEqual({ type: "user", id: "person" });
});

it("names the person an API-key agent represents", async () => {
	const { person, sqlite } = fixture();
	principal(sqlite, "api_key", "key-id", { representedUserId: "person" });
	expect(await create(agent(person))).toMatchObject({
		type: "user",
		id: "person",
	});
});

it("names the owner of an owner-host agent session", async () => {
	const { person, sqlite } = fixture();
	sqlite.exec("UPDATE organization_members SET role='owner'");
	principal(sqlite, "owner_user", "person");
	sqlite.exec(`INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,credit_eligible,started_at,last_seen_at)
		VALUES('host-session','${org}','agent','codex:example:owner-host','codex','1','openai','example','1','explicit',0,'2026-11-17T00:00:00Z','2026-11-17T00:00:00Z')`);
	expect(
		await create({
			...person,
			user: { sub: "subject", scopes: ["mcp:work.admin"] },
			ownerHostSessionId: "host-session",
		} as BaseContext),
	).toMatchObject({ type: "user", id: "person" });
});

it.each([
	["a workload agent", "github_actions_oidc", "repo:example/repo", ""],
	[
		"an agent whose person left",
		"aih_m2m",
		"client-id",
		"UPDATE organization_members SET status='suspended'",
	],
	[
		"an agent registered in another organization",
		"aih_m2m",
		"client-id",
		"UPDATE external_agent_principals SET organization_id='other'",
	],
])("names nobody for %s", async (_name, binding, bindingId, sql) => {
	const { person, sqlite } = fixture();
	principal(sqlite, binding, bindingId);
	if (sql) sqlite.exec(sql);
	expect(await create(agent(person))).toEqual({ type: null, id: null });
});
