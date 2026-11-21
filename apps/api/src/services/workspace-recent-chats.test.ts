import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbQueryClient } from "@tedix/db/query-client";

const roles = vi.hoisted(() => new Map<string, string | null | Error>());

vi.mock("@tedix/db/queries/os-workspace-access", () => ({
	readWorkspaceRuntimeRole: async (
		_db: unknown,
		scope: { workspaceId: string },
		principal: { actorId: string; actorKind: string },
	) => {
		expect(principal).toEqual({ actorId: "person-1", actorKind: "user" });
		const role = roles.get(scope.workspaceId);
		if (role instanceof Error) throw role;
		return role ?? null;
	},
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: async (_db: unknown, scope: { workspaceId: string }) => ({
		id: scope.workspaceId,
		name: `Workspace ${scope.workspaceId}`,
	}),
}));

const { listRecentWorkspaceChats } = await import("./workspace-recent-chats");

const owner = { organizationId: "org-fictional", userId: "person-1" };
const entry = (workspaceId: string, conversationId: string, at: string) => ({
	workspaceId,
	conversationId,
	title: conversationId,
	lastMessageAt: at,
});

describe("listRecentWorkspaceChats", () => {
	beforeEach(() => roles.clear());

	it("lists only chats in workspaces the person can still chat in, and forgets lost ones", async () => {
		roles.set("open", "build");
		roles.set("revoked", null);
		// Chat needs the build role; a use-only viewer cannot open it.
		roles.set("viewer", "use");
		roles.set("failing", new Error("database overloaded"));
		const forgotten: string[] = [];
		const deferred: Promise<unknown>[] = [];
		const chats = await listRecentWorkspaceChats(
			{} as DbQueryClient,
			{
				listPersonChats: async () => [
					entry("revoked", "gone", "2026-11-21T12:00:00Z"),
					entry("open", "newer", "2026-11-21T11:00:00Z"),
					entry("failing", "kept-for-later", "2026-11-21T10:30:00Z"),
					entry("open", "older", "2026-11-21T10:00:00Z"),
					entry("viewer", "view-only", "2026-11-21T09:00:00Z"),
				],
				forgetPersonChatWorkspace: async (_owner, workspaceId) => {
					forgotten.push(workspaceId);
				},
			},
			owner,
			10,
			(work) => deferred.push(work),
		);
		await Promise.all(deferred);
		expect(chats.map((chat) => chat.conversationId)).toEqual([
			"newer",
			"older",
		]);
		expect(chats[0]?.workspaceName).toBe("Workspace open");
		// A failed check hides entries this time but never deletes them.
		expect(forgotten.sort()).toEqual(["revoked", "viewer"]);
	});

	it("stops at the limit", async () => {
		roles.set("open", "build");
		const chats = await listRecentWorkspaceChats(
			{} as DbQueryClient,
			{
				listPersonChats: async () => [
					entry("open", "a", "2026-11-21T12:00:00Z"),
					entry("open", "b", "2026-11-21T11:00:00Z"),
				],
				forgetPersonChatWorkspace: async () => {},
			},
			owner,
			1,
		);
		expect(chats.map((chat) => chat.conversationId)).toEqual(["a"]);
	});
});
