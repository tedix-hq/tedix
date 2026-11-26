import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbQueryClient } from "@tedix/db/query-client";

const roles = vi.hoisted(() => new Map<string, string | null | Error>());

vi.mock("@tedix/db/queries/os-workspace-access", () => ({
	readWorkspaceUserAccessMany: async (
		_db: unknown,
		organizationId: string,
		userId: string,
		workspaceIds: string[],
	) => {
		expect({ organizationId, userId }).toEqual({
			organizationId: "org-fictional",
			userId: "person-1",
		});
		return new Map(
			workspaceIds.map((id) => {
				const role = roles.get(id);
				if (role instanceof Error) throw role;
				return [id, { name: `Workspace ${id}`, role: role ?? null }];
			}),
		);
	},
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
		const forgotten: string[] = [];
		const deferred: Promise<unknown>[] = [];
		const chats = await listRecentWorkspaceChats(
			{} as DbQueryClient,
			{
				listPersonChats: async () => [
					entry("revoked", "gone", "2026-11-21T12:00:00Z"),
					entry("open", "newer", "2026-11-21T11:00:00Z"),
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
		expect(forgotten.sort()).toEqual(["revoked", "viewer"]);
	});

	it("hides a failed access batch without forgetting entries", async () => {
		roles.set("failing", new Error("database overloaded"));
		const forget = vi.fn(async () => {});
		expect(
			await listRecentWorkspaceChats(
				{} as DbQueryClient,
				{
					listPersonChats: async () => [entry("failing", "kept", "2026-11-21")],
					forgetPersonChatWorkspace: forget,
				},
				owner,
				10,
			),
		).toEqual([]);
		expect(forget).not.toHaveBeenCalled();
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
