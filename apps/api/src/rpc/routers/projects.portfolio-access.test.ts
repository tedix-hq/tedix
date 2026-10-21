import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { projects } from "@tedix/db/schema/projects";
import { tedis } from "@tedix/db/schema/tedis";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { workProjectHealthJudgments } from "@tedix/db/schema/work-factory";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const ORG = "11111111-1111-4111-8111-111111111111";
const PRIVATE = "22222222-2222-4222-8222-222222222222";
const PUBLIC = "33333333-3333-4333-8333-333333333333";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			projects,
			organizationMembers,
			tedis,
			workItems,
			workAttempts,
			workProjectHealthJudgments,
			workAgentSessions,
		),
	);
	sqlite.exec(`
		INSERT INTO projects (id,org_id,key,name,created_at) VALUES
		('${PRIVATE}','${ORG}','A-PRIVATE','Private reviews','2026-01-01'),
		('${PUBLIC}','${ORG}','ORCHARD','Orchard research','2026-01-01');
		INSERT INTO organization_members (id,organization_id,descope_user_id,email,role,kind,status) VALUES
		('member','${ORG}','member','member@example.test','member','human','active'),
		('owner','${ORG}','owner','owner@example.test','owner','human','active');
		INSERT INTO work_items (id,org_id,title,project_id,created_at) VALUES
		('private-item','${ORG}','Private review finding','${PRIVATE}','2026-01-01'),
		('public-item','${ORG}','Orchard research task','${PUBLIC}','2026-01-01');
	`);
	const facade = createD1Facade(sqlite);
	const db = createDbClient(facade);
	function client(role: "member" | "owner") {
		return createRouterClient(projectsContractRouter, {
			context: {
				authType: "user",
				user: { sub: role, roles: [role] },
				userRole: role,
				organizationId: ORG,
				db,
				env: {
					DB: facade,
					ENVIRONMENT: "test",
					AGENT_REVIEW_PROJECT_ID: PRIVATE,
				},
				headers: new Headers(),
				url: new URL("https://api.example.test/rpc/projects"),
			} as BaseContext,
		});
	}
	return { client };
}

describe("private review portfolio visibility", () => {
	it("returns a member's public portfolio without disclosing the private project or weakening direct guards", async () => {
		const { client } = fixture();
		const result = await client("member").getPortfolio({});
		expect(result.data.map((row) => row.project.id)).toEqual([PUBLIC]);
		expect(result.data[0]).toMatchObject({
			total: 1,
			byDisposition: { proposed: 1 },
			next: { id: "public-item", title: "Orchard research task" },
		});
		expect(JSON.stringify(result)).not.toContain("Private review");
		await expect(client("member").get({ id: PRIVATE })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	it("retains the complete portfolio for an active organization owner", async () => {
		const { client } = fixture();
		const result = await client("owner").getPortfolio({});
		expect(result.data.map((row) => row.project.id)).toEqual([PRIVATE, PUBLIC]);
		expect(result.data.map((row) => row.total)).toEqual([1, 1]);
		expect((await client("owner").get({ id: PRIVATE })).id).toBe(PRIVATE);
	});
});
