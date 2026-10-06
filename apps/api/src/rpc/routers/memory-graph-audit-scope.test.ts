import { createRouterClient } from "@orpc/server";
import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";

const ORG = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const OTHER_ORG = "7c1d5f30-2b44-4e51-9a12-8d3f6b7c9e01";
const TEDI = "3d1a6a2e-8a4f-4b6e-9c1d-0f2e3a4b5c6d";
const mocks = vi.hoisted(() => ({
	getTediById: vi.fn(),
	auditMemoryGraph: vi.fn(),
}));
vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: mocks.getTediById,
}));
vi.mock("@tedix/db/queries/memory-audit", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/memory-audit")>()),
	auditMemoryGraph: mocks.auditMemoryGraph,
}));

async function audit(scope: "self" | "all", inherited = false) {
	const { memoryGraphContractRouter } = await import("./memory-graph");
	const context = {
		authType: "user",
		db: {},
		env: { ENVIRONMENT: "test", DB: {} },
		headers: new Headers(),
		organizationId: ORG,
		...(inherited ? { tediId: TEDI } : {}),
		url: new URL("https://api.tedix.test/rpc/memoryGraph"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["tedis:read"],
			roles: [],
			sub: "user-1",
		},
	} as unknown as BaseContext;
	return createRouterClient(memoryGraphContractRouter, { context }).audit({
		...(inherited ? {} : { tediId: TEDI }),
		scope,
		sourceSessionId: "exact-chat-run",
		limit: 6,
	});
}

describe("memory audit target ownership", () => {
	beforeAll(async () => {
		await import("./memory-graph");
	}, 120_000);
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it.each(["self", "all"] as const)(
		"rejects a foreign target before a misleading empty %s audit",
		async (scope) => {
			mocks.getTediById.mockResolvedValue({
				id: TEDI,
				organizationId: OTHER_ORG,
			});
			await expect(audit(scope)).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.auditMemoryGraph).not.toHaveBeenCalled();
		},
	);
	it("rejects an unknown target", async () => {
		mocks.getTediById.mockResolvedValue(null);
		await expect(audit("self")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.auditMemoryGraph).not.toHaveBeenCalled();
	});
	it("validates an inherited target too", async () => {
		mocks.getTediById.mockResolvedValue({
			id: TEDI,
			organizationId: OTHER_ORG,
		});
		await expect(audit("self", true)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.auditMemoryGraph).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"preserves same-organization audit filters (inherited=%s)",
		async (inherited) => {
			mocks.getTediById.mockResolvedValue({ id: TEDI, organizationId: ORG });
			const result = { facts: [{ id: "saved-fact" }], counts: { total: 1 } };
			mocks.auditMemoryGraph.mockResolvedValue(result);
			await expect(audit("self", inherited)).resolves.toEqual(result);
			expect(mocks.auditMemoryGraph).toHaveBeenCalledWith(
				expect.objectContaining({ organizationId: ORG, tediId: TEDI }),
				expect.objectContaining({
					scope: "self",
					source_session_id: "exact-chat-run",
					limit: 6,
				}),
			);
		},
	);
});
