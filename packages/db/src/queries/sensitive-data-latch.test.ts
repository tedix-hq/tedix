import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { skillRuns } from "../schema/cognitive";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { connectionInstances } from "../schema/connection-instances";
import { connectionProviders } from "../schema/connection-providers";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	clearRunSensitiveDataLatch,
	getRunSensitiveDataLatch,
	isConnectionProviderRestricted,
	latchRunSensitiveData,
} from "./sensitive-data-latch";

const ORG = "org-1";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			skillRuns,
			kernelRuntimeRuns,
			connectionInstances,
			connectionProviders,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, workflow_instance_id, runtime_environment, status) VALUES (?, ?, 'skill-1', 'tedi-1', ?, 'production', 'running')",
		)
		.run("run-1", ORG, "wf-1");
	sqlite
		.prepare(
			"INSERT INTO kernel_runtime_runs (id, organization_id, conversation_id, status, created_at, updated_at) VALUES (?, ?, 'conv-1', 'running', 'now', 'now')",
		)
		.run("home-1", ORG);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

const latch = (toolId: string) => ({
	version: 1 as const,
	latchedAt: "2026-10-27T10:00:00.000Z",
	source: {
		appSlug: "payroll",
		toolId,
		connectionProviderId: null,
		reason: "tool_declared_sensitive" as const,
	},
});

describe("run sensitive-data latch", () => {
	it.each([
		{ kind: "skill_run" as const, id: "run-1" },
		{ kind: "kernel_run" as const, id: "home-1" },
	])(
		"latches $kind once, keeps it across reads, and clears it",
		async (runRef) => {
			const { db } = fixture();
			expect(
				await getRunSensitiveDataLatch(db, { organizationId: ORG, runRef }),
			).toEqual({ known: true, latch: null });

			const first = await latchRunSensitiveData(db, {
				organizationId: ORG,
				runRef,
				latch: latch("list_salaries"),
			});
			expect(first.latch?.source.toolId).toBe("list_salaries");

			// A later read never rewrites the recorded first source.
			const second = await latchRunSensitiveData(db, {
				organizationId: ORG,
				runRef,
				latch: latch("get_contract"),
			});
			expect(second.latch?.source.toolId).toBe("list_salaries");

			// A fresh client (continuation, replay) sees the same row state.
			expect(
				(await getRunSensitiveDataLatch(db, { organizationId: ORG, runRef }))
					.latch?.source.toolId,
			).toBe("list_salaries");

			expect(
				(await clearRunSensitiveDataLatch(db, { organizationId: ORG, runRef }))
					?.source.toolId,
			).toBe("list_salaries");
			expect(
				await getRunSensitiveDataLatch(db, { organizationId: ORG, runRef }),
			).toEqual({ known: true, latch: null });
			expect(
				await clearRunSensitiveDataLatch(db, { organizationId: ORG, runRef }),
			).toBeNull();
		},
	);

	it("is tenant-bound and reports unknown runs", async () => {
		const { db } = fixture();
		const runRef = { kind: "skill_run" as const, id: "run-1" };
		expect(
			await latchRunSensitiveData(db, {
				organizationId: "org-2",
				runRef,
				latch: latch("list_salaries"),
			}),
		).toEqual({ known: false, latch: null });
		expect(
			await getRunSensitiveDataLatch(db, { organizationId: ORG, runRef }),
		).toEqual({ known: true, latch: null });
		expect(
			await getRunSensitiveDataLatch(db, {
				organizationId: ORG,
				runRef: { kind: "kernel_run", id: "missing" },
			}),
		).toEqual({ known: false, latch: null });
	});

	it("treats only a restricted classification as sensitive", async () => {
		const { sqlite, db } = fixture();
		sqlite
			.prepare(
				"INSERT INTO connection_providers (id, default_data_sensitivity, name, description, icon, category, type, recommended_scope, supported_scopes, required_scopes) VALUES (?, ?, 'HR', 'HR', 'hr', 'business', 'api_key', 'tenant', '[]', '[]')",
			)
			.run("hr-system", "restricted");
		sqlite
			.prepare(
				"INSERT INTO connection_providers (id, default_data_sensitivity, name, description, icon, category, type, recommended_scope, supported_scopes, required_scopes) VALUES (?, ?, 'CRM', 'CRM', 'crm', 'business', 'api_key', 'tenant', '[]', '[]')",
			)
			.run("crm", "confidential");
		sqlite
			.prepare(
				"INSERT INTO connection_instances (id, owner_user_id, organization_id, provider_id, label, data_sensitivity, token_ids, created_at, updated_at) VALUES (?, 'user-1', ?, ?, 'main', ?, '[]', 'now', 'now')",
			)
			.run("inst-1", ORG, "crm", "restricted");

		expect(
			await isConnectionProviderRestricted(db, {
				organizationId: ORG,
				providerId: "hr-system",
			}),
		).toBe(true);
		expect(
			await isConnectionProviderRestricted(db, {
				organizationId: ORG,
				providerId: "crm",
			}),
		).toBe(true);
		expect(
			await isConnectionProviderRestricted(db, {
				organizationId: "org-2",
				providerId: "crm",
			}),
		).toBe(false);
		expect(
			await isConnectionProviderRestricted(db, {
				organizationId: ORG,
				providerId: "unknown",
			}),
		).toBe(false);
	});
});
