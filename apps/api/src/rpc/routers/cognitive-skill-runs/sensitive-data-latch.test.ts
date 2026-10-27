import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { skillRuns } from "@tedix/db/schema/cognitive";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { userContext } from "../../test-context";
import { skillsContractRouter } from "../cognitive";
import { SENSITIVE_DATA_LATCH_CLEARED_ACTION } from "./sensitive-data-latch";

const ORG = "org-1";
const LATCH = JSON.stringify({
	version: 1,
	latchedAt: "2026-10-27T10:00:00.000Z",
	source: {
		appSlug: "hr",
		toolId: "list_salaries",
		connectionProviderId: "hr-system",
		reason: "connection_restricted",
	},
});

function harness() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(organizationMembers, skillRuns, kernelRuntimeRuns, auditEvents),
	);
	sqlite
		.prepare(
			"INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, workflow_instance_id, runtime_environment, status, sensitive_data_latch) VALUES ('run-1', ?, 'skill-1', 'tedi-1', 'wf-1', 'production', 'running', ?)",
		)
		.run(ORG, LATCH);
	sqlite
		.prepare(
			"INSERT INTO kernel_runtime_runs (id, organization_id, conversation_id, status, created_at, updated_at) VALUES ('home-1', ?, 'conv-1', 'completed', 'now', 'now')",
		)
		.run(ORG);
	const member = sqlite.prepare(
		"INSERT INTO organization_members (id, organization_id, user_id, descope_user_id, email, role, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
	);
	member.run(
		"m-admin",
		ORG,
		"user-admin",
		"admin",
		"admin@example.test",
		"admin",
	);
	member.run(
		"m-member",
		ORG,
		"user-member",
		"member",
		"member@example.test",
		"member",
	);
	const env = {
		ENVIRONMENT: "test",
		DB: createD1Facade(sqlite),
	} as unknown as CloudflareEnv;
	const client = (sub: string) =>
		createRouterClient(skillsContractRouter, {
			context: userContext({
				env,
				organizationId: ORG,
				sub,
				permissions: ["tedis:read", "tedis:update"],
			}),
		});
	return { sqlite, admin: client("admin"), member: client("member") };
}

describe("run sensitive-data lock", () => {
	it("shows the lock to any reader and reports unknown runs", async () => {
		const h = harness();
		await expect(
			h.member.getRunSensitiveDataLatch({
				runRef: { kind: "skill_run", id: "run-1" },
			}),
		).resolves.toMatchObject({
			known: true,
			latch: { source: { toolId: "list_salaries" } },
		});
		await expect(
			h.member.getRunSensitiveDataLatch({
				runRef: { kind: "kernel_run", id: "home-1" },
			}),
		).resolves.toEqual({ known: true, latch: null });
		await expect(
			h.member.getRunSensitiveDataLatch({
				runRef: { kind: "kernel_run", id: "nope" },
			}),
		).resolves.toEqual({ known: false, latch: null });
	});

	it("lets an admin clear the lock once, with an audit event naming the reviewer", async () => {
		const h = harness();
		const runRef = { kind: "skill_run" as const, id: "run-1" };
		await expect(
			h.member.clearRunSensitiveDataLatch({
				runRef,
				reason: "looked fine",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await expect(
			h.admin.clearRunSensitiveDataLatch({
				runRef,
				reason: "Reviewed the salary export; nothing leaves the org",
			}),
		).resolves.toMatchObject({
			cleared: true,
			latch: { source: { toolId: "list_salaries" } },
		});
		await expect(h.admin.getRunSensitiveDataLatch({ runRef })).resolves.toEqual(
			{ known: true, latch: null },
		);
		await expect(
			h.admin.clearRunSensitiveDataLatch({ runRef, reason: "again" }),
		).resolves.toEqual({ cleared: false, latch: null });

		const rows = h.sqlite
			.prepare(
				"SELECT actor_id, actor_type, action, resource_type, resource_id, metadata FROM audit_events",
			)
			.all() as Array<Record<string, string>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actor_id: "user-admin",
			actor_type: "user",
			action: SENSITIVE_DATA_LATCH_CLEARED_ACTION,
			resource_type: "skill_run",
			resource_id: "run-1",
		});
		expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({
			reason: "Reviewed the salary export; nothing leaves the org",
			reviewerRole: "admin",
			latch: { source: { toolId: "list_salaries" } },
		});

		await expect(
			h.admin.clearRunSensitiveDataLatch({
				runRef: { kind: "kernel_run", id: "nope" },
				reason: "x",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
