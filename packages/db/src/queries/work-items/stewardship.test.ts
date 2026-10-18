import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { OrganizationMetadataSchema } from "@tedix/api-contract/schemas/organization";
import { createDbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
import { workItems } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { createWorkItem } from "./crud";

const orgId = "fictional-org";
const lead = "11111111-1111-4111-8111-111111111111";
const area = "22222222-2222-4222-8222-222222222222";
const fallback = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const now = "2026-10-18T00:00:00.000Z";
type Policy = NonNullable<
	ReturnType<typeof OrganizationMetadataSchema.parse>["workStewardship"]
>;

function fixture(policy?: Partial<Policy>) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(organizations, projects, tedis, workItems));
	const config = policy ? { enabled: true, ...policy } : undefined;
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug,metadata) VALUES(?,?,?,?)")
		.run(
			orgId,
			"Fictional",
			"fictional",
			JSON.stringify({ workStewardship: config }),
		);
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,key,name,lead_tedi_id,created_at) VALUES(?,?,?,?,?,?)",
		)
		.run(projectId, orgId, "EXAMPLE", "Example", lead, now);
	for (const id of [lead, area, fallback])
		sqlite
			.prepare(
				"INSERT INTO tedis(id,organization_id,name,slug,status) VALUES(?,?,?,?,?)",
			)
			.run(id, orgId, id, id, "active");
	const db = createDbQueryClient(createD1Facade(sqlite));
	const create = (input: Partial<Parameters<typeof createWorkItem>[1]> = {}) =>
		createWorkItem(db, {
			id: crypto.randomUUID(),
			orgId,
			title: "Example work",
			workKind: "coding",
			createdAt: now,
			...input,
		});
	return { sqlite, create };
}

describe("organization Work stewardship on creation", () => {
	it("is opt-in and preserves explicit and human ownership", async () => {
		expect((await fixture().create()).stewardId).toBeNull();
		expect(
			(await fixture({ enabled: false, defaultTediId: fallback }).create())
				.stewardId,
		).toBeNull();
		const { create } = fixture({ defaultTediId: fallback });
		for (const input of [
			{ accountableOwnerType: "user" as const, accountableOwnerId: "person" },
			{ accountableOwnerType: "tedi" as const, accountableOwnerId: lead },
			{ metadata: { executor: "human" } },
		])
			expect((await create(input)).stewardId).toBeNull();
		expect(
			(await create({ stewardType: "tedi", stewardId: lead })).stewardId,
		).toBe(lead);
	});

	it("uses a configured project override before its lead and work-kind defaults", async () => {
		const { create } = fixture({
			projectStewards: { [projectId]: area },
			workKindStewards: { coding: fallback },
			defaultTediId: fallback,
		});
		const item = await create({ projectId });
		expect(item.stewardType).toBe("tedi");
		expect(item.stewardId).toBe(area);
		expect(item.accountableOwnerId).toBeNull();
		expect(item.disposition).toBe("proposed");
		expect(item.acceptanceContract).toBeNull();
	});

	it("inherits a project lead, then work kind, then the org fallback", async () => {
		expect(
			(await fixture({ defaultTediId: fallback }).create({ projectId }))
				.stewardId,
		).toBe(lead);
		expect(
			(
				await fixture({
					workKindStewards: { coding: area },
					defaultTediId: fallback,
				}).create()
			).stewardId,
		).toBe(area);
		expect(
			(await fixture({ defaultTediId: fallback }).create()).stewardId,
		).toBe(fallback);
		expect(
			(
				await fixture({
					useProjectLead: false,
					defaultTediId: fallback,
				}).create({ projectId })
			).stewardId,
		).toBe(fallback);
	});

	it("rejects unknown, cross-tenant, paused and retired targets without another fallback", async () => {
		for (const change of [
			"DELETE FROM tedis WHERE id = ?",
			"UPDATE tedis SET organization_id = 'other' WHERE id = ?",
			"UPDATE tedis SET status = 'paused' WHERE id = ?",
			"UPDATE tedis SET retired_at = '2026-01-01' WHERE id = ?",
		]) {
			const { sqlite, create } = fixture({
				projectStewards: { [projectId]: area },
				defaultTediId: fallback,
			});
			sqlite.prepare(change).run(area);
			expect((await create({ projectId })).stewardId).toBeNull();
		}
		const { sqlite, create } = fixture({ defaultTediId: fallback });
		sqlite
			.prepare("UPDATE projects SET org_id = 'other' WHERE id = ?")
			.run(projectId);
		expect((await create({ projectId })).stewardId).toBeNull();
	});

	it("ignores malformed persisted policy and validates API policy IDs", async () => {
		const { sqlite, create } = fixture();
		sqlite.prepare("UPDATE organizations SET metadata = ?").run(
			JSON.stringify({
				workStewardship: { enabled: true, defaultTediId: "invalid" },
			}),
		);
		expect((await create()).stewardId).toBeNull();
		expect(
			OrganizationMetadataSchema.safeParse({
				workStewardship: { enabled: true, projectStewards: { invalid: area } },
			}).success,
		).toBe(false);
	});
});
