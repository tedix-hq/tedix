import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import {
	osWorkspaceCollaborators,
	osWorkspaceAccessEdges,
	osWorkspaceShareLinks,
	osWorkspaceShareKeys,
} from "../../schema/os-collaborators";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	kernelConversations,
	kernelRuntimeRuns,
} from "../../schema/cognitive-runtime";
import {
	osGadgets,
	osOutputRevisions,
	osOutputs,
	osWorkspaceResources,
	osWorkspaces,
} from "../../schema/os-workspaces";
import { userConfigs } from "../../schema/user-configs";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsWorkspace,
	deleteOsWorkspace,
	getOsWorkspace,
	getOsWorkspaceByName,
	getPersonalOsWorkspace,
	isOsWorkspaceVisibleTo,
	listOsWorkspaces,
	findOsWorkspaceIdForKernelRun,
	saveConversationAsOsWorkspace,
	updateOsWorkspace,
} from "./workspaces";

function fixture(...extraTables: Parameters<typeof schemaDdl>) {
	const sqlite = new DatabaseSync(":memory:");
	// The OS table is emitted from the same Drizzle object production uses, so a
	// column added to `os_workspaces` cannot drift away from what this fixture
	// creates. Only the `organizations` parent is stubbed — these queries read
	// none of its columns, they just need the FK target to exist.
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			userConfigs,
			osOutputs,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceShareKeys,
			...extraTables.filter((table) => table !== osOutputs),
		),
	);
	return createDbQueryClient(createD1Facade(sqlite));
}

const ANYONE = { userIds: [] };

const workspace = {
	id: "ws-1",
	organizationId: "org-1",
	name: "Operations",
	createdByKind: "user" as const,
	createdById: "u-1",
};

describe("os workspaces", () => {
	it("creates and reads only inside the owning organization", async () => {
		const db = fixture();
		const created = await createOsWorkspace(db, workspace);
		expect(created).toMatchObject({ id: "ws-1", status: "active" });
		expect(
			await getOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
			}),
		).toMatchObject({ name: "Operations" });
		expect(
			await getOsWorkspace(db, {
				organizationId: "org-2",
				workspaceId: "ws-1",
			}),
		).toBeUndefined();
		expect(await listOsWorkspaces(db, "org-1", ANYONE)).toHaveLength(1);
		expect(await listOsWorkspaces(db, "org-2", ANYONE)).toHaveLength(0);
	});

	it("enforces the per-organization name uniqueness, not global", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		await expect(
			createOsWorkspace(db, { ...workspace, id: "ws-dup" }),
		).rejects.toThrow();
		expect(
			await createOsWorkspace(db, {
				...workspace,
				id: "ws-2",
				organizationId: "org-2",
			}),
		).toMatchObject({ id: "ws-2" });
	});

	it("updates and archives within tenant scope only", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		expect(
			await updateOsWorkspace(
				db,
				{ organizationId: "org-2", workspaceId: "ws-1" },
				{ status: "archived" },
			),
		).toBeUndefined();
		const archived = await updateOsWorkspace(
			db,
			{ organizationId: "org-1", workspaceId: "ws-1" },
			{ status: "archived", description: "retired" },
		);
		expect(archived).toMatchObject({
			status: "archived",
			description: "retired",
		});
		const filtered = await listOsWorkspaces(db, "org-1", ANYONE, {
			status: "active",
		});
		expect(filtered).toHaveLength(0);
	});

	it("keeps every private output behind an owner-only workspace after deletion", async () => {
		const db = fixture();
		await createOsWorkspace(db, {
			...workspace,
			visibility: "private",
			ownerUserId: "u-1",
		});
		for (const kind of ["document", "sheet", "presentation"] as const) {
			await db.insert(osOutputs).values({
				id: kind,
				organizationId: "org-1",
				workspaceId: workspace.id,
				kind,
				title: kind,
				createdByKind: "user",
				createdById: "u-1",
			});
		}
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-2",
				workspaceId: workspace.id,
			}),
		).toBe(false);
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: workspace.id,
			}),
		).toBe(true);
		expect(
			await getOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: workspace.id,
			}),
		).toBeUndefined();
		const [retained] = await listOsWorkspaces(db, "org-1", {
			userIds: ["u-1"],
		});
		expect(retained).toMatchObject({
			visibility: "private",
			ownerUserId: "u-1",
			status: "active",
		});
		expect(retained!.id).not.toBe(workspace.id);
		expect(await listOsWorkspaces(db, "org-1", ANYONE)).toEqual([]);
		const outputs = await db.select().from(osOutputs);
		expect(outputs).toHaveLength(3);
		expect(outputs.every((output) => output.workspaceId === retained!.id)).toBe(
			true,
		);
	});

	it("rolls back private output relocation if a restrictive reference prevents deletion", async () => {
		const db = fixture();
		await createOsWorkspace(db, {
			...workspace,
			visibility: "private",
			ownerUserId: "u-1",
		});
		await db.insert(osOutputs).values({
			id: "private-doc",
			organizationId: "org-1",
			workspaceId: workspace.id,
			kind: "document",
			title: "Private",
			createdByKind: "user",
			createdById: "u-1",
		});
		await db.run(
			sql`CREATE TABLE workspace_holds (workspace_id TEXT REFERENCES os_workspaces(id) ON DELETE RESTRICT)`,
		);
		await db.run(
			sql`INSERT INTO workspace_holds (workspace_id) VALUES (${workspace.id})`,
		);
		await expect(
			deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: workspace.id,
			}),
		).rejects.toThrow(/FOREIGN KEY/);
		expect((await db.select().from(osOutputs))[0]?.workspaceId).toBe(
			workspace.id,
		);
		expect(
			(await listOsWorkspaces(db, "org-1", { userIds: ["u-1"] })).map(
				(row) => row.id,
			),
		).toEqual([workspace.id]);
		expect(await listOsWorkspaces(db, "org-1", ANYONE)).toEqual([]);
	});

	it("does not replace an empty private workspace", async () => {
		const db = fixture();
		await createOsWorkspace(db, {
			...workspace,
			visibility: "private",
			ownerUserId: "u-1",
		});
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: workspace.id,
			}),
		).toBe(true);
		expect(await listOsWorkspaces(db, "org-1", { userIds: ["u-1"] })).toEqual(
			[],
		);
	});

	it("deletes within tenant scope and reports whether a row went", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-2",
				workspaceId: "ws-1",
			}),
		).toBe(false);
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
			}),
		).toBe(true);
		expect(await listOsWorkspaces(db, "org-1", ANYONE)).toHaveLength(0);
	});

	it("takes the workspace's apps and resource links with it but keeps its outputs", async () => {
		const db = fixture(osGadgets, osWorkspaceResources, osOutputs);
		await createOsWorkspace(db, workspace);
		const createdBy = { createdByKind: "user" as const, createdById: "u-1" };
		await db.insert(osGadgets).values({
			id: "app-1",
			organizationId: "org-1",
			workspaceId: "ws-1",
			name: "Scratch app",
			...createdBy,
		});
		await db.insert(osWorkspaceResources).values({
			id: "res-1",
			organizationId: "org-1",
			workspaceId: "ws-1",
			providerId: "tedix",
			connectionScope: "tenant",
			resourceType: "file",
			providerResourceId: "upload-1",
			name: "notes.pdf",
			...createdBy,
		});
		await db.insert(osOutputs).values({
			id: "out-1",
			organizationId: "org-1",
			workspaceId: "ws-1",
			kind: "document",
			title: "Kept notes",
			...createdBy,
		});

		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
			}),
		).toBe(true);
		expect(await db.select().from(osGadgets)).toHaveLength(0);
		expect(await db.select().from(osWorkspaceResources)).toHaveLength(0);
		expect(await db.select().from(osOutputs)).toMatchObject([
			{ id: "out-1", workspaceId: "ws-1" },
		]);
	});

	it("deletes every user's presentation preference in the same D1 batch", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		await db.insert(userConfigs).values([
			{
				id: "pref-1",
				userId: "u-1",
				namespace: "tedix-os-workspaces:org-1",
				key: "ws-1",
				value: { favorite: true },
			},
			{
				id: "pref-2",
				userId: "u-2",
				namespace: "tedix-os-workspaces:org-1",
				key: "ws-1",
				value: { favorite: false },
			},
		]);
		expect(
			await deleteOsWorkspace(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
				preferenceNamespace: "tedix-os-workspaces:org-1",
			}),
		).toBe(true);
		expect(await db.select().from(userConfigs)).toHaveLength(0);
	});

	it("shows a private workspace only to its owner, with no role bypass", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		await createOsWorkspace(db, {
			...workspace,
			id: "ws-private",
			name: "Robin (private)",
			visibility: "private",
			ownerUserId: "u-owner",
		});
		const names = async (userIds: string[]) =>
			(await listOsWorkspaces(db, "org-1", { userIds })).map((w) => w.id);
		expect(await names(["u-owner"])).toEqual(["ws-1", "ws-private"]);
		expect(await names(["u-other"])).toEqual(["ws-1"]);
		expect(await names([])).toEqual(["ws-1"]);
		const row = await getOsWorkspace(db, {
			organizationId: "org-1",
			workspaceId: "ws-private",
		});
		expect(row && isOsWorkspaceVisibleTo(row, { userIds: ["u-owner"] })).toBe(
			true,
		);
		expect(row && isOsWorkspaceVisibleTo(row, { userIds: ["u-other"] })).toBe(
			false,
		);
	});

	it("searches name and description case-insensitively inside the viewer's reach", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		await createOsWorkspace(db, {
			...workspace,
			id: "ws-digest",
			name: "Community digest",
			description: "Reddit intelligence",
		});
		await createOsWorkspace(db, {
			...workspace,
			id: "ws-private",
			name: "Reddit (private)",
			visibility: "private",
			ownerUserId: "u-owner",
		});
		const ids = async (search: string, userIds: string[] = []) =>
			(await listOsWorkspaces(db, "org-1", { userIds }, { search })).map(
				(row) => row.id,
			);
		expect(await ids("operations")).toEqual(["ws-1"]);
		// A description match works, and a private workspace only matches a
		// viewer who can open it.
		expect(await ids("reddit")).toEqual(["ws-digest"]);
		expect(await ids("REDDIT", ["u-owner"])).toEqual([
			"ws-digest",
			"ws-private",
		]);
		expect(await ids("missing")).toEqual([]);
		// A blank search lists everything; `instr` tolerates a query longer
		// than D1's 50-byte LIKE pattern cap without an error.
		expect(await ids("   ")).toHaveLength(2);
		expect(
			await ids(`a ${"long".repeat(20)} search phrase that fits nowhere`),
		).toEqual([]);
	});

	it("shows a private workspace to a viewer holding exactly its id", async () => {
		const db = fixture();
		await createOsWorkspace(db, workspace);
		for (const id of ["ws-linked", "ws-other"])
			await createOsWorkspace(db, {
				...workspace,
				id,
				name: id,
				visibility: "private",
				ownerUserId: "u-owner",
			});
		const viewer = { userIds: [], workspaceIds: ["ws-linked"] };
		expect(
			(await listOsWorkspaces(db, "org-1", viewer)).map((w) => w.id),
		).toEqual(["ws-1", "ws-linked"]);
		const other = await getOsWorkspace(db, {
			organizationId: "org-1",
			workspaceId: "ws-other",
		});
		expect(other && isOsWorkspaceVisibleTo(other, viewer)).toBe(false);
	});
});

describe("save a conversation as a workspace", () => {
	function conversationFixture() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
			CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL);
			INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
		`);
		sqlite.exec(
			schemaDdl(
				osWorkspaces,
				osOutputs,
				osOutputRevisions,
				kernelRuntimeRuns,
				kernelConversations,
			),
		);
		return createDbQueryClient(createD1Facade(sqlite));
	}

	async function seedOutput(
		db: ReturnType<typeof conversationFixture>,
		input: {
			id: string;
			workspaceId: string | null;
			conversationId: string;
			organizationId?: string;
		},
	) {
		const organizationId = input.organizationId ?? "org-1";
		const accountable = {
			organizationId,
			createdByKind: "user" as const,
			createdById: "u-1",
		};
		await db.insert(osOutputs).values({
			...accountable,
			id: input.id,
			workspaceId: input.workspaceId,
			kind: "document",
			title: input.id,
			currentRevisionId: `${input.id}-r1`,
		});
		await db.insert(osOutputRevisions).values({
			...accountable,
			id: `${input.id}-r1`,
			outputId: input.id,
			revision: 1,
			content: "{}",
		});
		await db.insert(kernelRuntimeRuns).values({
			id: `run-${input.id}`,
			organizationId,
			conversationId: input.conversationId,
			outputRevisionId: `${input.id}-r1`,
		});
	}

	it("moves the conversation's unplaced and default outputs and links it", async () => {
		const db = conversationFixture();
		await createOsWorkspace(db, {
			...workspace,
			id: "ws-general",
			name: "General",
		});
		await createOsWorkspace(db, {
			...workspace,
			id: "ws-other",
			name: "Other",
		});
		await seedOutput(db, {
			id: "out-loose",
			workspaceId: null,
			conversationId: "home:os:a",
		});
		await seedOutput(db, {
			id: "out-general",
			workspaceId: "ws-general",
			conversationId: "home:os:a",
		});
		await seedOutput(db, {
			id: "out-placed",
			workspaceId: "ws-other",
			conversationId: "home:os:a",
		});
		await seedOutput(db, {
			id: "out-elsewhere",
			workspaceId: null,
			conversationId: "home:os:b",
		});
		await db.insert(kernelConversations).values({
			id: "org-1:home:os:a",
			organizationId: "org-1",
			conversationId: "home:os:a",
			lastMessageAt: "2026-10-16T00:00:00.000Z",
			createdAt: "2026-10-16T00:00:00.000Z",
			updatedAt: "2026-10-16T00:00:00.000Z",
		});

		const saved = await saveConversationAsOsWorkspace(db, {
			workspace: { ...workspace, id: "ws-new", name: "Launch plan" },
			conversationId: "home:os:a",
			fromWorkspaceIds: ["ws-general"],
		});

		expect(saved.workspace).toMatchObject({
			id: "ws-new",
			name: "Launch plan",
		});
		expect(saved.movedOutputIds.sort()).toEqual(["out-general", "out-loose"]);
		expect(saved.linked).toBe(true);
		const placement = Object.fromEntries(
			(await db.select().from(osOutputs)).map((row) => [
				row.id,
				row.workspaceId,
			]),
		);
		expect(placement).toEqual({
			"out-loose": "ws-new",
			"out-general": "ws-new",
			"out-placed": "ws-other",
			"out-elsewhere": null,
		});
		const [conversation] = await db.select().from(kernelConversations);
		expect(conversation?.workspaceId).toBe("ws-new");
		expect(
			await getOsWorkspaceByName(db, {
				organizationId: "org-1",
				name: "General",
			}),
		).toMatchObject({ id: "ws-general" });
		expect(
			await getOsWorkspaceByName(db, {
				organizationId: "org-2",
				name: "General",
			}),
		).toBeUndefined();
	});

	it("finds a member's own oldest active private workspace only", async () => {
		const db = conversationFixture();
		const privateTo = (id: string, owner: string, createdAt: string) => ({
			...workspace,
			id,
			name: id,
			visibility: "private" as const,
			ownerUserId: owner,
			createdAt,
		});
		await createOsWorkspace(db, { ...workspace, id: "ws-org", name: "Org" });
		await createOsWorkspace(db, privateTo("ws-late", "u-1", "2026-10-02"));
		await createOsWorkspace(db, privateTo("ws-first", "u-1", "2026-10-01"));
		await createOsWorkspace(db, privateTo("ws-theirs", "u-2", "2026-09-01"));
		const lookup = { organizationId: "org-1", ownerUserId: "u-1" };
		expect((await getPersonalOsWorkspace(db, lookup))?.id).toBe("ws-first");
		await updateOsWorkspace(
			db,
			{ organizationId: "org-1", workspaceId: "ws-first" },
			{ status: "archived" },
		);
		expect((await getPersonalOsWorkspace(db, lookup))?.id).toBe("ws-late");
		expect(
			await getPersonalOsWorkspace(db, { ...lookup, ownerUserId: "u-3" }),
		).toBeUndefined();
	});

	it("never relinks a conversation that already belongs to a workspace", async () => {
		const db = conversationFixture();
		await createOsWorkspace(db, {
			...workspace,
			id: "ws-other",
			name: "Other",
		});
		await db.insert(kernelConversations).values({
			id: "org-1:home:os:a",
			organizationId: "org-1",
			conversationId: "home:os:a",
			workspaceId: "ws-other",
			lastMessageAt: "2026-10-16T00:00:00.000Z",
			createdAt: "2026-10-16T00:00:00.000Z",
			updatedAt: "2026-10-16T00:00:00.000Z",
		});
		const saved = await saveConversationAsOsWorkspace(db, {
			workspace: { ...workspace, id: "ws-new", name: "Second" },
			conversationId: "home:os:a",
			fromWorkspaceIds: [],
		});
		expect(saved.linked).toBe(false);
		const [conversation] = await db.select().from(kernelConversations);
		expect(conversation?.workspaceId).toBe("ws-other");
	});

	it("finds the Workspace a turn or its delegated child run belongs to", async () => {
		const db = conversationFixture();
		await createOsWorkspace(db, { ...workspace, id: "ws-chat", name: "Chat" });
		const at = "2026-10-25T00:00:00.000Z";
		await db.insert(kernelConversations).values([
			{
				id: "org-1:home:ws",
				organizationId: "org-1",
				conversationId: "home:ws",
				workspaceId: "ws-chat",
				lastMessageAt: at,
				createdAt: at,
				updatedAt: at,
			},
			{
				id: "org-1:home:global",
				organizationId: "org-1",
				conversationId: "home:global",
				lastMessageAt: at,
				createdAt: at,
				updatedAt: at,
			},
		]);
		await db.insert(kernelRuntimeRuns).values([
			{
				id: "run-ws",
				organizationId: "org-1",
				conversationId: "home:ws",
				childRunId: "child-run",
			},
			{
				id: "run-global",
				organizationId: "org-1",
				conversationId: "home:global",
			},
		]);
		const find = (organizationId: string, runId: string) =>
			findOsWorkspaceIdForKernelRun(db, { organizationId, runId });
		expect(await find("org-1", "run-ws")).toBe("ws-chat");
		expect(await find("org-1", "child-run")).toBe("ws-chat");
		expect(await find("org-1", "run-global")).toBeNull();
		expect(await find("org-2", "run-ws")).toBeNull();
	});
});
