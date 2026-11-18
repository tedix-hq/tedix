import { DatabaseSync } from "node:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	osCollaborationProposals,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { osShareLinks } from "@tedix/db/schema/os-shares";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import type { BaseContext } from "../rpc/orpc";

const object = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn() }));
vi.mock("./workspace-output-storage", () => ({
	getOsOutput: object.get,
	deleteOsOutput: object.remove,
}));
vi.mock("./os-workspace-visibility", () => ({
	assertOsWorkspaceChildVisible: vi.fn(),
	assertOsWorkspaceVisible: vi.fn(),
}));
import { purgeArchivedOsItems } from "./os-archived-purge";

let sqlite: DatabaseSync;
let context: BaseContext;
let db: ReturnType<typeof createDbQueryClient>;

function indexed(outputId: string) {
	return {
		id: `${outputId}:1`,
		organizationId: "org-1",
		workspaceId: "ws-1",
		outputId,
		revision: 1,
		revisionId: `${outputId}-r1`,
		isCurrent: 1,
		outputKind: "document" as const,
		title: outputId,
		status: "archived" as const,
		outputCreatedByKind: "user" as const,
		outputCreatedById: "u-1",
		outputCreatedAt: "2026-10-01",
		revisionCreatedByKind: "user" as const,
		revisionCreatedById: "u-1",
		revisionCreatedAt: "2026-10-01",
		updatedAt: "2026-10-01",
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workspaceOutputIndex,
			osWorkspaces,
			osCollaborationProposals,
			osShareLinks,
		),
	);
	const binding = createD1Facade(sqlite);
	db = createDbQueryClient(binding);
	context = {
		organizationId: "org-1",
		db: createDbClient(binding),
		env: { DB: binding },
		headers: new Headers(),
	} as BaseContext;
});
afterEach(() => sqlite.close());

describe("indexed output purge", () => {
	it("confirms every indexed candidate through object storage and skips missing or active outputs", async () => {
		for (const id of ["archived", "active", "missing"])
			await db.insert(workspaceOutputIndex).values(indexed(id));
		object.get.mockImplementation(async (_db, { outputId }) =>
			outputId === "missing"
				? undefined
				: {
						id: outputId,
						organizationId: "org-1",
						workspaceId: "ws-1",
						status: outputId === "active" ? "active" : "archived",
					},
		);
		const result = await purgeArchivedOsItems(
			context,
			{ kinds: ["outputs"], dryRun: true },
			{ workspacePreferenceNamespace: "test", now: () => 0 },
		);
		expect(result.outputs).toMatchObject({
			examined: 3,
			eligible: 1,
			deleted: 0,
			skipped: 2,
			skippedByReason: { not_archived: 2 },
			sampleIds: ["archived"],
			remaining: 0,
		});
		expect(object.get).toHaveBeenCalledTimes(3);
		for (const id of ["archived", "active", "missing"])
			expect(object.get).toHaveBeenCalledWith(expect.anything(), {
				organizationId: "org-1",
				outputId: id,
			});
		expect(object.remove).not.toHaveBeenCalled();
	});

	it("leaves indexed candidates countable when the budget stops before confirmation", async () => {
		for (const id of ["a", "b"])
			await db.insert(workspaceOutputIndex).values(indexed(id));
		const result = await purgeArchivedOsItems(
			context,
			{ kinds: ["outputs"], dryRun: true },
			{ workspacePreferenceNamespace: "test", workBudget: 0, now: () => 0 },
		);
		expect(result).toMatchObject({
			complete: false,
			stoppedBy: "work_budget",
			outputs: { examined: 0, remaining: 2 },
		});
		expect(object.get).not.toHaveBeenCalled();
		expect(object.remove).not.toHaveBeenCalled();
	});
});
