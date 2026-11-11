import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ getOrganizationProfile: vi.fn() }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationProfile: mocks.getOrganizationProfile,
}));

import {
	notifyOutputRevision,
	resetOutputRevisionNoticeCache,
} from "./os-output-revision-notice";

const notice = {
	outputId: "33333333-3333-4333-8333-333333333333",
	revisionId: "44444444-4444-4444-8444-444444444444",
	revision: 8,
};
const workspaceId = "11111111-1111-4111-8111-111111111111";

/** A room namespace that records which room was told what. */
function rooms(fail = false) {
	const posts: { room: string; path: string; body: unknown }[] = [];
	return {
		posts,
		namespace: {
			getByName: (room: string) => ({
				fetch: async (request: Request) => {
					if (fail) throw new Error("room unavailable");
					posts.push({
						room,
						path: new URL(request.url).pathname,
						body: await request.json(),
					});
					return new Response(null, { status: 204 });
				},
			}),
		} as unknown as DurableObjectNamespace,
	};
}
const db = {} as never;

describe("telling a workspace that a file has a new revision", () => {
	beforeEach(() => {
		resetOutputRevisionNoticeCache();
		mocks.getOrganizationProfile.mockReset();
		mocks.getOrganizationProfile.mockResolvedValue({ slug: "blueharbor" });
	});

	it("posts the ids to the workspace's live room, by the organization's slug", async () => {
		const room = rooms();
		await notifyOutputRevision(
			{ db, rooms: room.namespace, env: {} },
			{ organizationId: "org-1", workspaceId },
			notice,
		);
		expect(room.posts).toEqual([
			{
				room: `blueharbor:${workspaceId}:workspace:${workspaceId}`,
				path: "/__internal/output-revision",
				body: notice,
			},
		]);
		// The slug is read once per organization, not once per save.
		await notifyOutputRevision(
			{ db, rooms: room.namespace, env: {} },
			{ organizationId: "org-1", workspaceId },
			{ ...notice, revision: 9 },
		);
		expect(mocks.getOrganizationProfile).toHaveBeenCalledTimes(1);
		expect(room.posts).toHaveLength(2);
	});

	it("also tells the single local host in development", async () => {
		const room = rooms();
		await notifyOutputRevision(
			{ db, rooms: room.namespace, env: {}, development: true },
			{ organizationId: "org-1", workspaceId },
			notice,
		);
		expect(room.posts.map((post) => post.room)).toEqual([
			`blueharbor:${workspaceId}:workspace:${workspaceId}`,
			`local:${workspaceId}:workspace:${workspaceId}`,
		]);
	});

	it("does nothing for a file outside a workspace, without a room binding or without a slug", async () => {
		const room = rooms();
		await notifyOutputRevision(
			{ db, rooms: room.namespace, env: {} },
			{ organizationId: "org-1", workspaceId: null },
			notice,
		);
		await notifyOutputRevision(
			{ db, rooms: undefined, env: {} },
			{ organizationId: "org-1", workspaceId },
			notice,
		);
		mocks.getOrganizationProfile.mockResolvedValue(null);
		await notifyOutputRevision(
			{ db, rooms: room.namespace, env: {} },
			{ organizationId: "org-2", workspaceId },
			notice,
		);
		expect(room.posts).toEqual([]);
	});

	it("never fails the save when the room cannot be reached", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			notifyOutputRevision(
				{ db, rooms: rooms(true).namespace, env: {} },
				{ organizationId: "org-1", workspaceId },
				notice,
			),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "notice.failed" }),
		);
		warn.mockRestore();
	});
});
