import { instantiateOsBlueprint } from "./os-workspace-outputs";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { expect, it, vi, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osBlueprints,
	osBlueprintRevisions,
} from "@tedix/db/schema/os-workspaces";
import {
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/tenant-store/outputs-schema";
import {
	kernelConversations,
	kernelRuntimeRuns,
} from "@tedix/db/schema/cognitive-runtime";
import {
	osWorkspaceCollaborators,
	osWorkspaceAccessEdges,
	osWorkspaceShareLinks,
	osWorkspaceShareKeys,
} from "@tedix/db/schema/os-collaborators";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import { workspaceOutputFixture } from "../../test/workspace-output-fixture";
import { createWorkspaceDocumentOwner } from "./workspace-document-owner";
import {
	saveConversationWorkspace,
	workspacePlacementId,
} from "./workspace-document-placement";
import { deleteWorkspaceWithDocuments } from "./workspace-document-delete";
import { createOsOutput } from "./workspace-output-storage";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";

vi.mock("./workspace-document-transfer", () => ({
	transferWorkspaceDocument: async (
		db: ReturnType<typeof createDbQueryClient>,
		_organizationId: string,
		transfer: { outputId: string; targetWorkspaceId: string },
	) => {
		await db
			.update(workspaceOutputIndex)
			.set({ workspaceId: transfer.targetWorkspaceId })
			.where(eq(workspaceOutputIndex.outputId, transfer.outputId));
	},
}));

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-test');",
	);
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osBlueprints,
			osBlueprintRevisions,
			osOutputs,
			osOutputRevisions,
			kernelConversations,
			kernelRuntimeRuns,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceShareKeys,
			userConfigs,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const store = workspaceOutputFixture(sqlite, { uninitialized: true });
	onTestFinished(() => sqlite.close());
	return { db, ...store };
}
const row = {
	id: "new",
	organizationId: "org-test",
	name: "New",
	visibility: "private" as const,
	ownerUserId: "owner",
	createdByKind: "user" as const,
	createdById: "owner",
};
async function firstWrite(
	db: ReturnType<typeof createDbQueryClient>,
	workspaceId: string,
	id = "first",
) {
	const scope = { organizationId: row.organizationId, workspaceId };
	return createOsOutput(
		db,
		scope,
		{
			...scope,
			id,
			kind: "document",
			title: "First",
			currentRevisionId: `rev-${id}`,
			createdByKind: "user",
			createdById: "owner",
		},
		{
			id: `rev-${id}`,
			outputId: id,
			organizationId: scope.organizationId,
			revision: 1,
			content: "",
			bodyR2Key: "body",
			contentSha256: "abc",
			contentBytes: 0,
			createdByKind: "user",
			createdById: "owner",
		},
	);
}

it("starts shared and permits the first write after ordinary workspace creation", async () => {
	const f = fixture();
	const scope = { organizationId: row.organizationId, workspaceId: row.id };
	expect(await f.runtime.outputQuery(scope, { op: "authority" })).toBe(
		"shared",
	);
	await expect(firstWrite(f.db, row.id)).rejects.toThrow(
		"activated workspace object",
	);
	await expect(
		f.runtime.outputQuery(scope, { op: "initialize" }),
	).rejects.toThrow("directory is missing");
	await createWorkspaceDocumentOwner(f.db, row);
	expect((await firstWrite(f.db, row.id)).output.workspaceId).toBe(row.id);
});

it("initializes a saved conversation's workspace before its first document", async () => {
	const f = fixture();
	await f.db.insert(kernelConversations).values({
		id: "conversation",
		organizationId: row.organizationId,
		conversationId: "chat",
		lastMessageAt: "now",
	});
	const saved = await saveConversationWorkspace(f.db, {
		workspace: row,
		conversationId: "chat",
		fromWorkspaceIds: [],
	});
	expect((await firstWrite(f.db, saved.workspace.id)).output.workspaceId).toBe(
		row.id,
	);
});

it("permanently removes an object workspace and its documents instead of creating a retained workspace", async () => {
	const f = fixture();
	const source = await createWorkspaceDocumentOwner(f.db, row);
	await firstWrite(f.db, source.id, "retained");
	await deleteWorkspaceWithDocuments(f.db, source);
	const retainedId = await workspacePlacementId(
		row.organizationId,
		`delete:${row.id}`,
	);
	expect(
		await getOsWorkspace(f.db, {
			organizationId: row.organizationId,
			workspaceId: retainedId,
		}),
	).toBeUndefined();
	expect(
		f.objectSql.prepare("SELECT count(*) AS n FROM os_outputs").get(),
	).toEqual({ n: 0 });
	expect(
		f.objectSql.prepare("SELECT count(*) AS n FROM os_output_revisions").get(),
	).toEqual({ n: 0 });
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(0);
});

it.each([false, true])(
	"initializes a blueprint workspace before its first document (gallery=%s)",
	async (gallery) => {
		const f = fixture();
		const copied = gallery
			? {
					blueprint: {
						id: "copy",
						organizationId: row.organizationId,
						name: "Copy",
						createdByKind: row.createdByKind,
						createdById: row.createdById,
						currentRevisionId: "copy-rev",
					},
					revision: {
						id: "copy-rev",
						organizationId: row.organizationId,
						blueprintId: "copy",
						revision: 1,
						definition: "{}",
						createdByKind: row.createdByKind,
						createdById: row.createdById,
					},
				}
			: undefined;
		const result = await instantiateOsBlueprint(f.db, {
			workspace: row,
			gadgets: [],
			revisions: [],
			blueprintCopy: copied,
		});
		expect(
			(await firstWrite(f.db, result.workspace.id)).output.workspaceId,
		).toBe(row.id);
	},
);
