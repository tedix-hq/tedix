import { DatabaseSync } from "node:sqlite";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { principalIdentities } from "@tedix/db/schema/principal-identities";
import { projects } from "@tedix/db/schema/projects";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { tedis } from "@tedix/db/schema/tedis";
import { users } from "@tedix/db/schema/users";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createContext } from "./context";
import { resolvePrimaryUserIdentity } from "./primary-user-identity";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

it("reads current membership and review policy in one primary batch despite replica routing and caller bookmarks", async () => {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			principalIdentities,
			projects,
			tediObjectives,
			tedis,
			users,
		),
	);
	sqlite.exec(
		"INSERT INTO organizations (id, name, slug, descope_tenant_id) VALUES ('org-one', 'One', 'one', 'tenant-one')",
	);
	sqlite.exec(
		"INSERT INTO organization_members (id, organization_id, descope_user_id, email, role) VALUES ('member-one', 'org-one', 'subject-one', 'one@example.test', 'owner')",
	);
	sqlite.exec(
		"INSERT INTO projects (id, org_id, name, key, metadata, created_at) VALUES ('review-one', 'org-one', 'Reviews', 'REV', '{}', '2026-11-20T00:00:00Z')",
	);
	const d1 = createD1Facade({
		prepare: (sql) => sqlite.prepare(sql),
		exec: (sql) => sqlite.exec(sql),
	});
	const batch = vi.fn();
	const withSession = d1.withSession.bind(d1);
	const session = vi
		.spyOn(d1, "withSession")
		.mockImplementation((constraint) => {
			const primary = withSession(constraint);
			const runBatch = primary.batch.bind(primary);
			vi.spyOn(primary, "batch").mockImplementation((statements) => {
				batch();
				return runBatch(statements);
			});
			return primary;
		});
	const env = { DB: d1, ENVIRONMENT: "production" } as CloudflareEnv;
	const input = {
		organizationIdentity: {
			provider: "descope",
			issuer: "issuer",
			subject: "tenant-one",
		},
		userIdentity: {
			provider: "descope",
			issuer: "issuer",
			subject: "subject-one",
		},
		reviewProjectId: "review-one",
	};
	const resolve = async () => {
		const context = createContext(
			new Request("https://api.example.test/rpc/test", {
				headers: { "x-d1-bookmark": "untrusted-bookmark" },
			}),
			env,
		);
		context.dbReadOnly = true;
		const value = await resolvePrimaryUserIdentity(context, input);
		return { value, metrics: context.dbMetrics };
	};
	const first = await resolve();
	expect(first.value?.memberRole).toBe("owner");
	expect(first.value?.reviewProject?.project?.metadata).toEqual({});
	expect(first.metrics?.queries).toBe(2);
	expect(session).toHaveBeenNthCalledWith(1, "first-primary");
	expect(batch).toHaveBeenCalledTimes(1);
	sqlite.exec(
		"UPDATE organization_members SET role = 'viewer' WHERE id = 'member-one'",
	);
	sqlite.exec(
		`UPDATE projects SET metadata = '{"agentReviewTriage":{"tediId":"triage-one"}}' WHERE id = 'review-one'`,
	);
	const second = await resolve();
	expect(second.value?.memberRole).toBe("viewer");
	expect(second.value?.reviewProject?.project?.metadata).toEqual({
		agentReviewTriage: { tediId: "triage-one" },
	});
	expect(batch).toHaveBeenCalledTimes(2);
	sqlite.exec(
		"UPDATE organization_members SET status = 'deactivated' WHERE id = 'member-one'",
	);
	expect((await resolve()).value).toMatchObject({
		memberIsActive: false,
		memberRole: null,
	});
	sqlite.exec("DELETE FROM projects WHERE id = 'review-one'");
	expect((await resolve()).value?.reviewProject).toEqual({
		id: "review-one",
		project: undefined,
	});
});
