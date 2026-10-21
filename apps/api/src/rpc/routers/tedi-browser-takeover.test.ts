import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	canManageBrowserEgress,
	ToolPolicySchema,
} from "@tedix/api-contract/schemas/tedi";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	resolve: vi.fn(),
	create: vi.fn(),
	getTedi: vi.fn(),
	status: vi.fn(),
	audit: vi.fn(),
	update: vi.fn(),
}));
vi.mock("@tedix/db/queries/approvals", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/approvals")>()),
	getApprovalRequestById: mocks.get,
	resolveApprovalRequest: mocks.resolve,
	createApprovalRequest: mocks.create,
}));
vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedis")>()),
	getTediByIdForOrganization: mocks.getTedi,
	getTediById: mocks.getTedi,
	updateTedi: mocks.update,
}));
vi.mock("@tedix/db/queries/audit", () => ({ insertAuditEvent: mocks.audit }));
vi.mock("@tedix/provisioning", async (original) => ({
	...(await original<typeof import("@tedix/provisioning")>()),
	getBrowserTakeoverStatus: mocks.status,
}));
import { tediApprovalsContractRouter } from "./tedi-approvals";
import { updateTediProcedure } from "./tedis/update";

const id = "00000000-0000-4000-8000-000000000001";
const orgId = "00000000-0000-4000-8000-000000000002";
const tediId = "00000000-0000-4000-8000-000000000003";
const payload = {
	kind: "browser_live_view_takeover",
	sessionId: "browser-1",
	sessionKey: "console-task",
};
const row = {
	id,
	orgId,
	tediId,
	actionType: "browser.live_view_takeover",
	payload,
	status: "pending",
	createdAt: "2026-10-01T00:00:00Z",
	expiresAt: "2099-10-01T00:00:00Z",
	resolvedAt: null,
	resolvedBy: null,
	resolution: null,
	workflowId: null,
};
function context(
	authType: "apikey" | "service-binding" = "apikey",
): BaseContext {
	return {
		authType,
		organizationId: orgId,
		db: {},
		headers: new Headers(
			authType === "service-binding" ? { "X-Service-Binding": "true" } : {},
		),
		apiKey: { scopes: ["*"] },
		env: {
			ENVIRONMENT: "test",
			TEDI_SERVICE: { fetch: vi.fn() },
			APPROVAL_WORKFLOW: { create: vi.fn() },
		},
		url: new URL("https://api.example.test/rpc"),
		rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
	} as unknown as BaseContext;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.get.mockResolvedValue(row);
	mocks.getTedi.mockResolvedValue({
		id: tediId,
		organizationId: orgId,
		slug: "example-worker",
		toolPolicy: null,
	});
	mocks.create.mockImplementation(async (_db, input) => ({ ...row, ...input }));
	mocks.resolve.mockResolvedValue({ ...row, status: "cancelled" });
	mocks.status.mockResolvedValue({
		status: "pending",
		sameSession: true,
		targets: [
			{ targetId: "tab-1", url: "https://live.browser.run/ui/view?fresh=1" },
		],
	});
});
describe("fresh takeover links", () => {
	it("asks the owning runtime for a fresh link on each authorized request", async () => {
		const client = createRouterClient(tediApprovalsContractRouter, {
			context: context(),
		});
		await expect(
			client.getBrowserTakeoverStatus({ id }),
		).resolves.toMatchObject({ sameSession: true });
		await client.getBrowserTakeoverStatus({ id });
		expect(mocks.status).toHaveBeenCalledTimes(2);
		expect(mocks.getTedi).toHaveBeenCalledWith(
			expect.anything(),
			tediId,
			orgId,
		);
	});
	it("does not touch the runtime for a cross-org request", async () => {
		mocks.get.mockResolvedValue({ ...row, orgId: "another-org" });
		await expect(
			createRouterClient(tediApprovalsContractRouter, {
				context: context(),
			}).getBrowserTakeoverStatus({ id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.status).not.toHaveBeenCalled();
	});
	it("rejects a runtime URL outside Cloudflare Live View", async () => {
		mocks.status.mockResolvedValue({
			status: "pending",
			sameSession: true,
			targets: [{ targetId: "tab-1", url: "https://attacker.example/" }],
		});
		await expect(
			createRouterClient(tediApprovalsContractRouter, {
				context: context(),
			}).getBrowserTakeoverStatus({ id }),
		).rejects.toThrow();
	});
});
describe("replace a stale takeover", () => {
	const input = {
		orgId,
		tediId,
		actionType: row.actionType,
		description: "Complete the human sign-in step",
		payload,
		replacesApprovalRequestId: id,
		ttlHours: 1,
	};
	it("cancels the prior pending request before creating the fresh gate", async () => {
		await createRouterClient(tediApprovalsContractRouter, {
			context: context("service-binding"),
		}).create(input);
		expect(mocks.resolve).toHaveBeenCalledWith(
			expect.anything(),
			id,
			expect.objectContaining({ status: "cancelled" }),
		);
		expect(mocks.create).toHaveBeenCalledOnce();
		expect(mocks.resolve.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.create.mock.invocationCallOrder[0]!,
		);
	});
	it("replaces an expired gate without trying to resolve it again", async () => {
		mocks.get.mockResolvedValue({ ...row, status: "expired" });
		await createRouterClient(tediApprovalsContractRouter, {
			context: context("service-binding"),
		}).create(input);
		expect(mocks.resolve).not.toHaveBeenCalled();
		expect(mocks.create).toHaveBeenCalledOnce();
	});
	it("rejects another session and concurrent resolution", async () => {
		const client = createRouterClient(tediApprovalsContractRouter, {
			context: context("service-binding"),
		});
		await expect(
			client.create({
				...input,
				payload: { ...payload, sessionId: "browser-2" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.resolve.mockResolvedValue(undefined);
		await expect(client.create(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
describe("browser egress authority", () => {
	it("admits only human organization admins", () => {
		for (const authType of [
			"user",
			"tedi",
			"m2m",
			"apikey",
			"service-binding",
			undefined,
		])
			for (const role of ["owner", "admin", "member", "viewer", undefined]) {
				expect(canManageBrowserEgress(authType, role)).toBe(
					authType === "user" && (role === "owner" || role === "admin"),
				);
			}
	});
	it.each(["apikey", "user"] as const)(
		"refuses an actual non-admin %s egress update before persistence",
		async (authType) => {
			const actor = context();
			if (authType === "user") {
				actor.authType = "user";
				actor.user = { sub: "example-member" };
				actor.userRole = "member";
				actor.userPermissionOverrides = ["tedis:update", "apps:update"];
			}
			const client = createRouterClient(
				{ update: updateTediProcedure },
				{ context: actor },
			);
			await expect(
				client.update({
					tediId,
					toolPolicy: ToolPolicySchema.parse({
						browserEgress: { presets: ["tedix-console-sign-in"] },
					}),
				}),
			).rejects.toThrow("Only organization admins");
			expect(mocks.update).not.toHaveBeenCalled();
		},
	);
});
