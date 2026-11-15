import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workCaseItems, workCases } from "../../schema/work-factory";
import { workItems } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { createWorkCase, getWorkCase, updateWorkCase } from "./cases";

const ORG = "org-fixture";
const NOW = "2026-11-15T12:00:00.000Z";
const LATER = "2026-11-16T12:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(workItems, workCases, workCaseItems));
	return createDbQueryClient(createD1Facade(sqlite));
}

const epic = {
	id: "epic-1",
	orgId: ORG,
	title: "Ship the harbor timetable",
	kind: "other",
	accountableOwnerType: "system",
	accountableOwnerId: "tedix",
	openedAt: NOW,
	now: NOW,
} as const;

describe("epic proof of delivery", () => {
	it("starts without proof unless one is given", async () => {
		const db = setup();
		expect((await createWorkCase(db, epic)).proofRef).toBeNull();
		const withProof = await createWorkCase(db, {
			...epic,
			id: "epic-2",
			targetResolutionAt: LATER,
			proofRef: "https://example.test/timetable",
		});
		expect(withProof).toMatchObject({
			targetResolutionAt: LATER,
			proofRef: "https://example.test/timetable",
			accountableOwnerId: "tedix",
		});
	});

	it("records proof, keeps it on other updates, and clears it on null", async () => {
		const db = setup();
		await createWorkCase(db, epic);
		const recorded = await updateWorkCase(db, {
			orgId: ORG,
			caseId: epic.id,
			expectedVersion: 1,
			proofRef: "Signed handover, file 12",
			now: LATER,
		});
		expect(recorded.proofRef).toBe("Signed handover, file 12");
		const closed = await updateWorkCase(db, {
			orgId: ORG,
			caseId: epic.id,
			expectedVersion: 2,
			stage: "closed",
			now: LATER,
		});
		expect(closed).toMatchObject({
			stage: "closed",
			proofRef: "Signed handover, file 12",
		});
		const cleared = await updateWorkCase(db, {
			orgId: ORG,
			caseId: epic.id,
			expectedVersion: 3,
			proofRef: null,
			now: LATER,
		});
		expect(cleared.proofRef).toBeNull();
		expect(
			(await getWorkCase(db, { orgId: ORG, caseId: epic.id })).proofRef,
		).toBeNull();
	});
});
