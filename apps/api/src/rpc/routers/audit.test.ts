import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	AUDIT_READ_PERMISSION,
	AUDIT_READ_SCOPE,
	auditContractRouter,
} from "./audit";

const mocks = vi.hoisted(() => ({
	getAuditEventsByResource: vi.fn(),
	insertAuditEvent: vi.fn(),
	searchAuditEvents: vi.fn(),
}));

vi.mock("@tedix/db/queries/audit", () => ({
	getAuditEventsByResource: mocks.getAuditEventsByResource,
	insertAuditEvent: mocks.insertAuditEvent,
	searchAuditEvents: mocks.searchAuditEvents,
}));

const ORG_ID = "org-1";

function createContext(permissions: string[]): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/audit"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			dct: "tenant-1",
			permissions,
			roles: [],
		},
	};
}

function createClient(context: BaseContext) {
	return createRouterClient(auditContractRouter, { context });
}

describe("audit router permissions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.searchAuditEvents.mockResolvedValue({ data: [], total: 0 });
	});

	it("maps audit reads to observability read access", () => {
		expect(AUDIT_READ_PERMISSION).toBe("analytics:read");
		expect(AUDIT_READ_SCOPE).toBe("analytics:read");
	});

	it("allows audit search for users with analytics read access", async () => {
		const client = createClient(createContext(["analytics:read"]));

		const result = await client.search({ action: "mcp.code.execute" });

		expect(result).toEqual({
			data: [],
			pagination: {
				hasMore: false,
				limit: 50,
				offset: 0,
				total: 0,
			},
		});
		expect(mocks.searchAuditEvents).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "mcp.code.execute",
				limit: 50,
				offset: 0,
				organizationId: ORG_ID,
			}),
		);
	});

	it("does not treat billing read as audit read access", async () => {
		const client = createClient(createContext(["billing:read"]));

		await expect(client.search({ action: "mcp.code.execute" })).rejects.toThrow(
			"Required: analytics:read",
		);
		expect(mocks.searchAuditEvents).not.toHaveBeenCalled();
	});
});
