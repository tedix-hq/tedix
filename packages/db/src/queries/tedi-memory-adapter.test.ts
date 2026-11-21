import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vite-plus/test";
import { describeGovernanceConformance } from "@tedix/agent-governance/conformance";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import { createDbQueryClient } from "../query-client";
import { tediMemoryDocuments } from "../schema/tedi-memory";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { TediMemoryAdapter } from "./tedi-memory-adapter";
import { appendTediMemoryDocumentVersion } from "./tedi-memory";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const scope = { organizationId: "org-test", tediId: "tedi-test" };
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(tediMemoryDocuments));
	const db = createDbQueryClient(createD1Facade(sqlite));
	return { db, memory: new TediMemoryAdapter(db, scope) };
}
describeGovernanceConformance("Tedi memory conformance", () => ({
	...createInMemoryAdapters(),
	memory: fixture().memory,
}));
it("maps legacy versions and fences organization, tedi, and competing revisions", async () => {
	const { db, memory } = fixture();
	const params = {
		...scope,
		id: "legacy",
		kind: "core" as const,
		name: "core",
		baseVersion: 0,
		sections: { project: "Short lesson" },
		charCount: 12,
		authorType: "reflection" as const,
		authorId: scope.tediId,
		changeSummary: "Replaced a section",
		createdAt: "2026-11-19T10:00:00.000Z",
		keepVersions: 20,
	};
	await appendTediMemoryDocumentVersion(db, params);
	const legacy = (await memory.read("core/"))!.current;
	expect(legacy).toMatchObject({
		revisionId: "legacy",
		revision: 1,
		value: params.sections,
		review: "pending",
		provenance: {
			actor: { id: scope.tediId, kind: "tedi" },
			source: { surface: "tedi_memory_reflection" },
		},
	});
	const otherStores = [
		new TediMemoryAdapter(db, { ...scope, organizationId: "other-org" }),
		new TediMemoryAdapter(db, { ...scope, tediId: "other-tedi" }),
	];
	for (const other of otherStores) {
		expect(await other.list()).toEqual([]);
		await expect(
			other.review("legacy", "approve", { id: "reviewer", kind: "user" }),
		).rejects.toThrow("Unknown memory revision");
		await expect(
			other.rollback("core/", "legacy", legacy.provenance),
		).rejects.toThrow("not a revision");
	}
	const reviewed = await memory.review("legacy", "approve", {
		id: "reviewer",
		kind: "user",
	});
	expect(
		(await new TediMemoryAdapter(db, scope).read("core/"))?.approved,
	).toEqual(reviewed);
	expect(
		await memory.appendDocument({ ...params, id: "competing" }),
	).toBeNull();
	expect(await memory.history("core/")).toHaveLength(1);
	const note = await memory.write({
		key: "core",
		value: { description: "A note", content: { nested: ["Separate note"] } },
		provenance: legacy.provenance,
	});
	expect((await memory.read("core"))?.current).toEqual(note);
	expect((await memory.read("core/"))?.current.value).toEqual(params.sections);
});
