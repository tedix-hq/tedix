import { DatabaseSync } from "node:sqlite";
import { ORPCError } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { workEvents } from "@tedix/db/schema/work-items";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { assertWorkItemAccess } from "./policy-helpers";

const itemId = "11111111-1111-4111-8111-111111111111";
const ownerOrg = "org_owner_private";
const ownerTitle = "Confidential roadmap";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(canonicalWorkFactoryDdl() + schemaDdl(workEvents));
	sqlite.exec(
		`INSERT INTO organizations(id,name,slug) VALUES('${ownerOrg}','Owner','owner'),('org_caller','Caller','caller');`,
	);
	const db = createDbClient(createD1Facade(sqlite));
	await createWorkItem(db, {
		id: itemId,
		orgId: ownerOrg,
		title: ownerTitle,
		createdBy: { type: "user", id: "member" },
		createdAt: "2026-10-19T00:00:00Z",
	});
	const contextFor = (organizationId: string) =>
		({
			db,
			organizationId,
			authType: "user",
			headers: new Headers(),
		}) as BaseContext;
	return { contextFor };
}

async function rejection(
	promise: Promise<unknown>,
): Promise<ORPCError<string, unknown>> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ORPCError) return error;
		throw error;
	}
	throw new Error("expected a rejection");
}

describe("assertWorkItemAccess", () => {
	it("returns the item for its own organization", async () => {
		const { contextFor } = await fixture();
		const item = await assertWorkItemAccess(contextFor(ownerOrg), itemId);
		expect(item.id).toBe(itemId);
	});

	it("keeps NOT_FOUND for an unknown id", async () => {
		const { contextFor } = await fixture();
		const error = await rejection(
			assertWorkItemAccess(
				contextFor("org_caller"),
				"22222222-2222-4222-8222-222222222222",
			),
		);
		expect(error.code).toBe("NOT_FOUND");
		expect(error.message).toBe("Work Item not found");
	});

	it("names only the caller's organization on a cross-organization denial", async () => {
		const { contextFor } = await fixture();
		const error = await rejection(
			assertWorkItemAccess(contextFor("org_caller"), itemId),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toBe(
			"Access denied to this Work Item: it is not in organization org_caller; select the owning organization (tedix --organization <org>) or check the id",
		);
		// The owning tenant's data must not leak through the denial.
		expect(error.message).not.toContain(ownerOrg);
		expect(error.message).not.toContain(ownerTitle);
		expect(error.data).toBeUndefined();
	});
});
