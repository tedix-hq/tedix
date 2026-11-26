import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createDurableSqliteFixture } from "@tedix/db/test/durable-sqlite-fixture";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { createTenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	executeOutputQuery,
	type DocumentTransferRuntime,
	type DocumentTransferPackage,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import {
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/tenant-store/outputs-schema";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import { transferWorkspaceDocument } from "./workspace-document-transfer";

const config = vi.hoisted(() => ({
	env: {} as { WORKSPACE_RUNTIME?: DocumentTransferRuntime },
}));
vi.mock("cloudflare:workers", () => ({ env: config.env }));
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	delete config.env.WORKSPACE_RUNTIME;
});

async function fixture(crash = "") {
	const sql = new DatabaseSync(":memory:"),
		objectSql = new DatabaseSync(":memory:");
	databases.push(sql, objectSql);
	sql.exec("PRAGMA foreign_keys=OFF;");
	sql.exec(schemaDdl(workspaceOutputIndex));
	objectSql.exec("PRAGMA foreign_keys=OFF;");
	objectSql.exec(schemaDdl(osOutputs, osOutputRevisions));
	const db = createDbQueryClient(createD1Facade(sql));
	const tenant = createTenantStoreDb(createDurableSqliteFixture(objectSql));
	const source = { organizationId: "org-test", workspaceId: "source" };
	const transfer = {
		transferId: "transfer-1",
		outputId: "doc",
		sourceWorkspaceId: "source",
		targetWorkspaceId: "target",
	};
	await executeOutputQuery(tenant, source, {
		op: "create",
		output: {
			id: "doc",
			...source,
			title: "Moving",
			kind: "document",
			currentRevisionId: "rev-1",
			createdByKind: "user",
			createdById: "owner",
		},
		revision: {
			id: "rev-1",
			organizationId: source.organizationId,
			outputId: "doc",
			revision: 1,
			content: "",
			bodyR2Key: "body-by-key",
			createdByKind: "user",
			createdById: "owner",
		},
	});
	const snapshot = (await executeOutputQuery(tenant, source, {
		op: "snapshot",
		outputId: "doc",
	}))!;
	await db.insert(workspaceOutputIndex).values({
		id: "doc:1",
		organizationId: source.organizationId,
		workspaceId: "source",
		outputId: "doc",
		revision: 1,
		revisionId: "rev-1",
		isCurrent: 1,
		outputKind: "document",
		title: "Moving",
		status: "active",
		outputCreatedByKind: "user",
		outputCreatedById: "owner",
		outputCreatedAt: "now",
		revisionCreatedByKind: "user",
		revisionCreatedById: "owner",
		revisionCreatedAt: "now",
		updatedAt: "now",
	});
	const payload: DocumentTransferPackage = {
		transfer,
		snapshot: {
			...snapshot,
			output: { ...snapshot.output, workspaceId: "target" },
		},
		batches: [],
	};
	const state = {
		imported: false,
		removed: false,
		crash,
		calls: [] as string[],
	};
	const fail = (step: string) => {
		if (state.crash === step) {
			state.crash = "";
			throw new Error(`Crash ${step}`);
		}
	};
	const runtime: DocumentTransferRuntime = {
		prepareDocumentTransfer: vi.fn(async () => {
			state.calls.push("prepare");
			fail("prepare");
			return state.removed ? { ...payload, completed: true } : payload;
		}),
		importDocumentTransfer: vi.fn(async () => {
			state.calls.push("import");
			fail("conflict");
			state.imported = true;
			fail("import");
		}),
		confirmDocumentTransfer: vi.fn(async () => {
			state.calls.push("confirm");
			if (!state.imported) throw new Error("Not imported");
			fail("confirm");
			return payload.snapshot;
		}),
		removeDocumentTransfer: vi.fn(async () => {
			state.calls.push("remove");
			fail("before-remove");
			expect(
				(await db.select().from(workspaceOutputIndex))[0]?.workspaceId,
			).toBe("target");
			expect(state.imported).toBe(true);
			state.removed = true;
			fail("after-remove");
		}),
	};
	config.env.WORKSPACE_RUNTIME = runtime;
	return {
		db,
		transfer,
		state,
		runtime,
		payload,
		run: () => transferWorkspaceDocument(db, source.organizationId, transfer),
	};
}

it("runs import, confirmation, index repoint and removal, then leaves completed retries alone", async () => {
	const f = await fixture();
	await expect(f.run()).resolves.toMatchObject({ workspaceId: "target" });
	expect(f.state.calls).toEqual(["prepare", "import", "confirm", "remove"]);
	expect(f.state.removed).toBe(true);
	f.runtime.removeDocumentTransfer = vi.fn(async () => {});
	await f.db.update(workspaceOutputIndex).set({ workspaceId: "later-home" });
	await f.run();
	expect(f.runtime.importDocumentTransfer).toHaveBeenCalledTimes(1);
	expect((await f.db.select().from(workspaceOutputIndex))[0]?.workspaceId).toBe(
		"later-home",
	);
});

it.each(["prepare", "import", "confirm", "before-remove", "after-remove"])(
	"recovers a crash at %s with the same transfer id",
	async (crash) => {
		const f = await fixture(crash);
		await expect(f.run()).rejects.toThrow(`Crash ${crash}`);
		if (crash === "before-remove") {
			expect(f.state.imported).toBe(true);
			expect(f.state.removed).toBe(false);
			expect(f.payload.snapshot.output.workspaceId).toBe("target");
			expect(
				(await f.db.select().from(workspaceOutputIndex))[0]?.workspaceId,
			).toBe("target");
		}
		await f.run();
		expect(f.state.removed).toBe(true);
		expect(
			(await f.db.select().from(workspaceOutputIndex))[0]?.workspaceId,
		).toBe("target");
	},
);

it("stops at a destination conflict without moving the index or removing the source", async () => {
	const f = await fixture("conflict");
	await expect(f.run()).rejects.toThrow("Crash conflict");
	expect(f.state.removed).toBe(false);
	expect(f.runtime.removeDocumentTransfer).not.toHaveBeenCalled();
	expect((await f.db.select().from(workspaceOutputIndex))[0]?.workspaceId).toBe(
		"source",
	);
});

it("keeps the source when index history conflicts with the pinned transfer", async () => {
	const f = await fixture();
	await f.db.update(workspaceOutputIndex).set({ revisionId: "unexpected" });
	await expect(f.run()).rejects.toThrow("index conflicts");
	expect(f.state.removed).toBe(false);
	expect(f.runtime.removeDocumentTransfer).not.toHaveBeenCalled();
});
