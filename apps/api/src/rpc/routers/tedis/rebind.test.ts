import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { computeRebindAgentId, performRebindIsolate } from "./rebind";

const CANARY = "https://hooks.example.test/secret-token";

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	updateTedi: vi.fn(async (_db: unknown, id: string, patch: object) => ({
		id,
		slug: "echo",
		...patch,
	})),
}));
vi.mock("../../audit-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../audit-helpers")>()),
	emitAuditEvent: vi.fn(async () => {
		throw new TypeError(`audit insert failed for ${CANARY}`);
	}),
}));

afterEach(() => vi.restoreAllMocks());

describe("computeRebindAgentId", () => {
	test("generates a fresh {slug}-rebind-{epochMs} name distinct from the current value", () => {
		const { isolateAgentId, previous } = computeRebindAgentId({
			slug: "echo",
			id: "11111111-1111-1111-1111-111111111111",
			currentIsolateAgentId: "echo-recover-1780168873",
			now: 1_790_000_000_000,
		});

		expect(previous).toBe("echo-recover-1780168873");
		expect(isolateAgentId).toBe("echo-rebind-1790000000000");
		expect(isolateAgentId).not.toBe(previous);
	});

	test("falls back to the tedi id when slug is null", () => {
		const { isolateAgentId, previous } = computeRebindAgentId({
			slug: null,
			id: "22222222-2222-2222-2222-222222222222",
			currentIsolateAgentId: null,
			now: 1_790_000_000_001,
		});

		// previous defaults to the slug part (id) when no prior id exists
		expect(previous).toBe("22222222-2222-2222-2222-222222222222");
		expect(isolateAgentId).toBe(
			"22222222-2222-2222-2222-222222222222-rebind-1790000000001",
		);
		expect(isolateAgentId).not.toBe(previous);
	});

	test("appends a random suffix when the generated name collides with the current value", () => {
		// Same millisecond already produced the current id — must still differ.
		const { isolateAgentId, previous } = computeRebindAgentId({
			slug: "echo",
			id: "33333333-3333-3333-3333-333333333333",
			currentIsolateAgentId: "echo-rebind-1790000000000",
			now: 1_790_000_000_000,
			randomSuffix: () => "abcd1234",
		});

		expect(previous).toBe("echo-rebind-1790000000000");
		expect(isolateAgentId).toBe("echo-rebind-1790000000000-abcd1234");
		expect(isolateAgentId).not.toBe(previous);
	});
});

describe("performRebindIsolate", () => {
	test("logs an audit failure as exception structure without its text", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const tedi = {
			id: "44444444-4444-4444-8444-444444444444",
			organizationId: "55555555-5555-4555-8555-555555555555",
			slug: "echo",
			isolateAgentId: "echo",
		};

		await performRebindIsolate(
			{ db: {}, env: {}, authType: "service-binding" } as never,
			tedi as never,
		);

		const logged = JSON.stringify(consoleError.mock.calls, (_key, value) =>
			value instanceof Error
				? { message: value.message, stack: value.stack }
				: value,
		);
		expect(logged).not.toContain("secret-token");
		expect(consoleError).toHaveBeenCalledWith(
			"[Tedis] Failed to emit audit event for tedi.rebind",
			{
				organizationId: tedi.organizationId,
				tediId: tedi.id,
				exception: { type: "TypeError" },
			},
		);
	});
});
