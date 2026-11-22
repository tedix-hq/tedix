import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	archiveProject,
	createProject,
	getProjectById,
} from "@tedix/db/queries/projects";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { projects } from "@tedix/db/schema/projects";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

it("restores the saved project status and archive date only for an owner/admin in its organization", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(
			"CREATE TABLE organizations (id TEXT PRIMARY KEY); CREATE TABLE tedis (id TEXT PRIMARY KEY); CREATE TABLE tedi_objectives (id TEXT PRIMARY KEY);",
		);
		sqlite.exec(schemaDdl(projects, organizationMembers));
		const db = createDbClient(createD1Facade(sqlite));
		const orgId = "20000000-0000-4000-8000-000000000001";
		const id = "10000000-0000-4000-8000-000000000001";
		const now = new Date().toISOString();
		sqlite.prepare("INSERT INTO organizations VALUES (?)").run(orgId);
		await db.insert(organizationMembers).values({
			id: "membership",
			organizationId: orgId,
			descopeUserId: "ada",
			email: "ada@example.test",
			userId: "ada",
			kind: "human",
			role: "member",
			status: "active",
			createdAt: now,
		});
		await createProject(db, {
			id,
			orgId,
			key: "ORCHARD",
			name: "Orchard",
			status: "paused",
			createdAt: now,
		});
		await archiveProject(db, id, now);
		await archiveProject(db, id, now);
		const context = {
			authType: "user",
			db,
			env: { ENVIRONMENT: "test" },
			headers: new Headers(),
			organizationId: orgId,
			url: new URL("https://api.tedix.test/rpc/projects"),
			user: { sub: "ada", permissions: ["tedis:update"], roles: [] },
		} as BaseContext;
		const client = createRouterClient(projectsContractRouter, { context });
		await expect(client.restore({ id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		sqlite.exec("UPDATE organization_members SET role = 'owner'");
		await expect(
			createRouterClient(projectsContractRouter, {
				context: { ...context, organizationId: "other-org" },
			}).restore({ id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(client.restore({ id })).resolves.toMatchObject({
			id,
			status: "paused",
			archivedAt: null,
		});
		expect(await getProjectById(db, id)).toMatchObject({
			status: "paused",
			archivedAt: null,
			archivedFromStatus: null,
		});
		await expect(client.restore({ id })).resolves.toMatchObject({
			status: "paused",
			archivedAt: null,
		});
	} finally {
		sqlite.close();
	}
});
