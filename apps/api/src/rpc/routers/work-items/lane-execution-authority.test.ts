import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { workEvents } from "@tedix/db/schema/work-items";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import type { LaneExecutionPolicy } from "@tedix/api-contract/schemas/lane-execution";
import type { BaseContext } from "../../orpc";
import { afterEach, expect, it } from "vite-plus/test";
import { createProcedure } from "./creation-reads";

const org = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const policy: LaneExecutionPolicy = {
	version: 1,
	role: "maker",
	sharedResourceKeys: ["shared"],
	makerResourceKey: "maker",
	reservedSlots: 1,
	budgetEnvelopeIds: ["envelope"],
	executors: [
		{
			id: "executor",
			kind: "codex",
			principalType: "external_agent",
			principalId: "agent",
			resourceKey: "executor",
			costMicros: null,
			capabilities: [],
		},
	],
	maxAttempts: 20,
	maxDelegationDepth: 10,
	delegationDepth: 0,
};
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture(role: string, change: Partial<BaseContext> = {}) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(organizationMembers, workEvents, tedis),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${org}','Example','example');
		INSERT INTO projects(id,org_id,key,name,status,metadata,created_at) VALUES('${project}','${org}','P','Project','active','{}','2026-10-19');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m','${org}','subject','person','person@example.test','${role}','active');
		INSERT INTO tedis(id,organization_id,name,slug) VALUES('worker','${org}','Worker','worker');`);
	const context = {
		db: createDbClient(createD1Facade(sqlite)),
		organizationId: org,
		authType: "user",
		user: { sub: "subject" },
		headers: new Headers(),
		...change,
	} as BaseContext;
	return { sqlite, context };
}

function create(context: BaseContext, laneExecution: unknown = policy) {
	return createProcedure["~orpc"].handler!({
		context,
		input: CreateWorkItemInputSchema.parse({
			title: "Fictional lane task",
			projectId: project,
			workClass: "hygiene",
			purposeExceptionExpiresAt: new Date(
				Date.now() + 86_400_000,
			).toISOString(),
			metadata: { laneExecution },
		}),
		path: [],
		procedure: createProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}

function count(sqlite: DatabaseSync) {
	return sqlite.prepare("SELECT count(*) AS count FROM work_items").get();
}

it.each([
	["a member", "member", {}],
	["a tedi", "owner", { authType: "tedi", tediId: "worker", user: undefined }],
	["an organization API key", "owner", { authType: "apikey", user: undefined }],
	[
		"an agent on an owner's session",
		"owner",
		{ ownerHostSessionId: "host-session" },
	],
	[
		"an external agent session",
		"owner",
		{ externalAgentPrincipalId: "agent", externalAgentSessionId: "session" },
	],
] as [string, string, Partial<BaseContext>][])(
	"refuses a lane execution policy set by %s",
	async (_name, role, change) => {
		const { sqlite, context } = fixture(role, change);
		await expect(create(context)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(count(sqlite)).toEqual({ count: 0 });
	},
);

it("refuses an owner's invalid lane execution policy", async () => {
	const { sqlite, context } = fixture("owner");
	await expect(
		create(context, { ...policy, maxAttempts: 21 }),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(count(sqlite)).toEqual({ count: 0 });
});

it.each(["owner", "admin"])(
	"stores a valid lane execution policy set by an %s",
	async (role) => {
		const { context } = fixture(role);
		await expect(create(context)).resolves.toMatchObject({
			metadata: { laneExecution: policy },
		});
	},
);
