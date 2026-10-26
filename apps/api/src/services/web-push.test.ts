import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	isPushEndpoint,
	webPushTemplate,
} from "@tedix/api-contract/schemas/web-push";
import { deliverWebPush, pushKind, shouldPush, webPushKeys } from "./web-push";
import type { BaseContext } from "../rpc/context";
import type { KernelRuntimeEvent } from "@tedix/db/queries/kernel-runtime-events";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	member: vi.fn(),
	members: vi.fn(),
	access: vi.fn(),
	configs: vi.fn(),
	visible: vi.fn(),
	remove: vi.fn(),
	build: vi.fn(),
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	getKernelRuntimeRun: mocks.run,
}));
vi.mock("@tedix/db/queries/kernel-conversations", () => ({
	getKernelConversation: vi.fn(async () => ({
		workspaceId: "00000000-0000-4000-8000-00000000000a",
	})),
}));
vi.mock("@tedix/db/queries/os-workspaces/projects", () => ({
	listOsWorkspaceProjects: vi.fn(async () => [{ projectId: "project-a" }]),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
	getMembersByOrganization: mocks.members,
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: vi.fn(async () => ({ id: "space-a" })),
	isOsWorkspaceVisibleTo: vi.fn(() => true),
}));
vi.mock("../kernel/conversation-access", () => ({
	resolveKernelConversationAccess: mocks.access,
}));
vi.mock("@tedix/db/queries/web-push", () => ({
	listPushConfigs: mocks.configs,
	hasVisiblePushConversation: mocks.visible,
	deletePushConfig: mocks.remove,
}));
vi.mock("@block65/webcrypto-web-push", () => ({
	buildPushPayload: mocks.build,
}));
const event = {
	id: "event-a",
	organizationId: "org-a",
	runId: "run-a",
	conversationId: "chat-a",
	kind: "run.completed",
	payload: { status: "completed", content: "private conversation" },
} as KernelRuntimeEvent;
const context = {
	db: {},
	env: {
		VAPID_PUBLIC_KEY: "public",
		VAPID_PRIVATE_KEY: "private",
		VAPID_SUBJECT: "mailto:operator@example.test",
	},
} as BaseContext;
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000000a";
const base = {
	personStarted: true,
	visible: false,
	projectIds: ["project-a"],
	mutedProjectIds: ["project-a"],
	workspaceId: WORKSPACE_ID,
	mutedWorkspaceIds: [] as string[],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.members.mockResolvedValue([]);
	mocks.run.mockResolvedValue({
		metadata: {
			pushRecipient: { descopeUserId: "subject-a", personStarted: true },
		},
	});
	mocks.member.mockResolvedValue({
		status: "active",
		userId: "person-a",
		descopeUserId: "subject-a",
	});
	mocks.access.mockResolvedValue({ allowed: true });
	mocks.visible.mockResolvedValue(false);
	mocks.configs.mockImplementation(async (_db, _scope, prefix) =>
		prefix === "preferences"
			? []
			: [
					{
						key: "subscription:one",
						value: {
							endpoint: "https://web.push.apple.com/device",
							keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
						},
					},
				],
	);
	mocks.build.mockResolvedValue({ method: "POST", body: "encrypted" });
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 201 })),
	);
});

describe("Web Push delivery", () => {
	it("keeps approvals enabled under project mute and suppresses all kinds for visible conversations", () => {
		expect(shouldPush({ ...base, kind: "approval" })).toBe(true);
		for (const kind of ["approval", "needs_input", "finished"] as const)
			expect(shouldPush({ ...base, kind, visible: true })).toBe(false);
		for (const kind of ["needs_input", "finished"] as const)
			expect(shouldPush({ ...base, kind })).toBe(false);
		expect(
			shouldPush({
				...base,
				kind: "finished",
				personStarted: false,
				mutedProjectIds: [],
			}),
		).toBe(false);
	});
	it("silences run updates in a muted workspace but never approvals", () => {
		const muted = {
			...base,
			mutedProjectIds: [],
			mutedWorkspaceIds: [WORKSPACE_ID],
		};
		for (const kind of ["needs_input", "finished"] as const)
			expect(shouldPush({ ...muted, kind })).toBe(false);
		expect(shouldPush({ ...muted, kind: "approval" })).toBe(true);
		// A conversation with no workspace can only be muted per project.
		expect(
			shouldPush({
				...muted,
				kind: "finished",
				workspaceId: null,
			}),
		).toBe(true);
	});
	it("classifies only settled person-facing outcomes", () => {
		expect(pushKind(event)).toBe("finished");
		expect(
			pushKind({ kind: "run.completed", payload: { status: "queued" } }),
		).toBe(null);
		expect(
			pushKind({
				kind: "run.completed",
				payload: {
					status: "needs_delegation",
					route: { routeKind: "ask_human" },
				},
			}),
		).toBe("needs_input");
		expect(pushKind({ kind: "approval.requested", payload: {} })).toBe(
			"approval",
		);
	});
	it("disables gracefully without the complete VAPID configuration", async () => {
		expect(webPushKeys({ VAPID_PUBLIC_KEY: "public" })).toBe(null);
		await deliverWebPush({ ...context, env: {} } as BaseContext, event);
		expect(mocks.run).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("uses fixed templates and a Deck link without conversation text", async () => {
		await deliverWebPush(context, event);
		const message = JSON.parse(mocks.build.mock.calls[0][0].data);
		expect(message).toMatchObject(webPushTemplate("finished"));
		expect(JSON.stringify(message)).not.toContain("private conversation");
		expect(fetch).toHaveBeenCalledWith(
			"https://web.push.apple.com/device",
			expect.objectContaining({ redirect: "error" }),
		);
	});
	it("suppresses sends into a muted workspace while approvals still deliver", async () => {
		mocks.configs.mockImplementation(async (_db, _scope, prefix) =>
			prefix === "preferences"
				? [
						{
							key: "preferences",
							value: {
								mutedProjectIds: [],
								mutedWorkspaceIds: [WORKSPACE_ID],
							},
						},
					]
				: [
						{
							key: "subscription:one",
							value: {
								endpoint: "https://web.push.apple.com/device",
								keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
							},
						},
					],
		);
		await deliverWebPush(context, event);
		expect(fetch).not.toHaveBeenCalled();
		await deliverWebPush(context, { ...event, kind: "approval.requested" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("does not send to a revoked member, inaccessible conversation, or stale arbitrary endpoint", async () => {
		mocks.member.mockResolvedValueOnce({
			status: "removed",
			userId: "person-a",
		});
		await deliverWebPush(context, event);
		mocks.access.mockResolvedValueOnce({ allowed: false });
		await deliverWebPush(context, event);
		mocks.configs.mockResolvedValue([
			{
				key: "subscription:bad",
				value: { endpoint: "https://internal.example.test" },
			},
		]);
		await deliverWebPush(context, event);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("queries owner and admin recipients directly for unattended approvals", async () => {
		mocks.run.mockResolvedValue({ metadata: {} });
		mocks.members.mockImplementation(async (_db, _org, options) =>
			options.role === "owner"
				? [
						{
							status: "active",
							userId: "owner-a",
							descopeUserId: "owner-subject",
						},
					]
				: [],
		);
		await deliverWebPush(context, { ...event, kind: "approval.requested" });
		expect(mocks.members).toHaveBeenCalledWith(context.db, "org-a", {
			status: "active",
			role: "owner",
		});
		expect(mocks.members).toHaveBeenCalledWith(context.db, "org-a", {
			status: "active",
			role: "admin",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("removes expired provider subscriptions only in the recipient scope", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 410 }));
		await deliverWebPush(context, event);
		expect(mocks.remove).toHaveBeenCalledWith(
			context.db,
			{ organizationId: "org-a", userId: "person-a" },
			"subscription:one",
		);
	});
	it("rejects SSRF destinations, credentials, ports and provider-looking suffixes", () => {
		const withCredentials = new URL("https://web.push.apple.com/a");
		withCredentials.username = "fixture-user";
		for (const endpoint of [
			"http://fcm.googleapis.com/a",
			"https://fcm.googleapis.com.evil.test/a",
			"https://127.0.0.1/a",
			withCredentials.href,
			"https://web.push.apple.com:8443/a",
		])
			expect(isPushEndpoint(endpoint)).toBe(false);
		expect(
			isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/a"),
		).toBe(true);
	});
});
