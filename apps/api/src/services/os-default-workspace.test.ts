import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import { listOsWorkspaces } from "@tedix/db/queries/os-workspaces/workspaces";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	ensureDefaultOsWorkspace,
	placeChatOutputInDefaultWorkspace,
} from "./os-default-workspace";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(osWorkspaces));
	return createDbQueryClient(createD1Facade(sqlite));
}

const member = {
	organizationId: "org-1",
	ownerUserId: "user-1",
	createdByKind: "user" as const,
	createdById: "user-1",
};
const service = {
	organizationId: "org-1",
	ownerUserId: null,
	createdByKind: "service" as const,
	createdById: "kernel",
};
const EVERYONE = { userIds: ["user-1", "user-2"] };

describe("default chat workspace", () => {
	it("gives a member one private space, reused for every later chat", async () => {
		const db = fixture();
		const first = await ensureDefaultOsWorkspace(db, member);
		const second = await ensureDefaultOsWorkspace(db, member);
		const third = await ensureDefaultOsWorkspace(db, member);
		expect(first).toMatchObject({
			name: "Chats (private)",
			visibility: "private",
			ownerUserId: "user-1",
		});
		expect(second?.id).toBe(first?.id);
		expect(third?.id).toBe(first?.id);
		expect(await listOsWorkspaces(db, "org-1", EVERYONE)).toHaveLength(1);
	});

	it("reuses a private space the member already has", async () => {
		const db = fixture();
		await db.insert(osWorkspaces).values({
			id: "ws-mine",
			organizationId: "org-1",
			name: "Robin (private)",
			visibility: "private",
			ownerUserId: "user-1",
			createdByKind: "user",
			createdById: "user-1",
		});
		expect((await ensureDefaultOsWorkspace(db, member))?.id).toBe("ws-mine");
	});

	it("gives a second member their own private space", async () => {
		const db = fixture();
		const first = await ensureDefaultOsWorkspace(db, member);
		const second = await ensureDefaultOsWorkspace(db, {
			...member,
			ownerUserId: "user-2",
			createdById: "user-2",
		});
		expect(second?.id).not.toBe(first?.id);
		expect(second).toMatchObject({
			visibility: "private",
			ownerUserId: "user-2",
		});
		expect(second?.name).toMatch(/^Chats \(private\) · [0-9a-f]{8}$/);
	});

	it("uses one shared General when no single member is behind the turn", async () => {
		const db = fixture();
		const first = await ensureDefaultOsWorkspace(db, service);
		expect(first).toMatchObject({ name: "General", visibility: "org" });
		expect((await ensureDefaultOsWorkspace(db, service))?.id).toBe(first?.id);
		await db.update(osWorkspaces).set({ status: "archived" });
		// An archived General stays archived; the output is left unassigned.
		expect(await ensureDefaultOsWorkspace(db, service)).toBeNull();
	});

	it("adds the default workspace only to an output create without one", async () => {
		const resolve = vi.fn().mockResolvedValue({ id: "ws-general" });
		const create = {
			toolName: "os.create_os_output",
			args: { kind: "document", title: "Trip notes" },
		};
		expect(
			(await placeChatOutputInDefaultWorkspace(create, resolve)).args,
		).toEqual({
			kind: "document",
			title: "Trip notes",
			workspaceId: "ws-general",
		});
		expect(
			(
				await placeChatOutputInDefaultWorkspace(
					{ ...create, toolName: "os__create_os_output" },
					resolve,
				)
			).args.workspaceId,
		).toBe("ws-general");
		const chosen = { ...create, args: { ...create.args, workspaceId: "ws-x" } };
		expect(await placeChatOutputInDefaultWorkspace(chosen, resolve)).toBe(
			chosen,
		);
		const rename = {
			toolName: "os.rename_os_output",
			args: { outputId: "o-1", title: "New" },
		};
		expect(await placeChatOutputInDefaultWorkspace(rename, resolve)).toBe(
			rename,
		);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("leaves the output unassigned when the default cannot be resolved", async () => {
		const create = {
			toolName: "os.create_os_output",
			args: { kind: "sheet", title: "Budget" },
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(
			await placeChatOutputInDefaultWorkspace(create, () =>
				Promise.reject(new Error("D1 unavailable")),
			),
		).toBe(create);
		warn.mockRestore();
	});
});
