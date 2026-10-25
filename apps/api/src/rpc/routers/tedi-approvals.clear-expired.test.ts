import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * "Clear expired" closes requests whose window has passed, for the caller's
 * organization only. Nothing was approved, so nothing runs.
 */

const mocks = vi.hoisted(() => ({
	expireStaleApprovals: vi.fn(),
	insertAuditEvent: vi.fn(),
}));

vi.mock("@tedix/db/queries/approvals", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/approvals")>()),
	expireStaleApprovals: mocks.expireStaleApprovals,
}));
vi.mock("@tedix/db/queries/audit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/audit")>()),
	insertAuditEvent: mocks.insertAuditEvent,
}));

import { tediApprovalsContractRouter } from "./tedi-approvals";

function createContext(organizationId: string | undefined): BaseContext {
	return {
		authType: "apikey",
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId,
			scopes: ["*"],
		},
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		...(organizationId ? { organizationId } : {}),
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/tedi-approvals/clear-expired"),
		user: undefined,
	} as BaseContext;
}

beforeEach(() => {
	mocks.expireStaleApprovals.mockReset();
	mocks.insertAuditEvent.mockReset();
});

describe("tediApprovals.clearExpired", () => {
	it("expires only the caller organization's overdue requests and audits it", async () => {
		mocks.expireStaleApprovals.mockResolvedValue(3);
		const client = createRouterClient(tediApprovalsContractRouter, {
			context: createContext("org-1"),
		});
		await expect(client.clearExpired({})).resolves.toEqual({ cleared: 3 });
		expect(mocks.expireStaleApprovals).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org-1",
			resolvedBy: "apikey",
		});
		expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: "org-1",
				action: "approval.expired",
			}),
		);
	});

	it("records no audit event when nothing was overdue", async () => {
		mocks.expireStaleApprovals.mockResolvedValue(0);
		const client = createRouterClient(tediApprovalsContractRouter, {
			context: createContext("org-1"),
		});
		await expect(client.clearExpired({})).resolves.toEqual({ cleared: 0 });
		expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
	});

	it("refuses a caller without an organization", async () => {
		const client = createRouterClient(tediApprovalsContractRouter, {
			context: createContext(undefined),
		});
		await expect(client.clearExpired({})).rejects.toThrow();
		expect(mocks.expireStaleApprovals).not.toHaveBeenCalled();
	});
});
