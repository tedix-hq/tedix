import { expect, it, vi } from "vite-plus/test";
import { createCoreStore } from "../core-store/client";
import { withCoreStore } from "../core-store/scope";
import { cmsQueryDb } from "./cms-control-plane";

vi.mock("../core-store/client", async (original) => ({
	...(await original<typeof import("../core-store/client")>()),
	createCoreStore: vi.fn(),
}));

// A raw D1 binding only needs `prepare` to be recognised as one.
const d1 = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;

it("resolves a raw D1 binding to the Postgres scope's client", async () => {
	const scoped = { kind: "postgres-client" };
	vi.mocked(createCoreStore).mockReturnValue({
		db: scoped as never,
		close: async () => undefined,
	});
	const env = {
		CORE_STORE: "postgres",
		CORE_HYPERDRIVE: { connectionString: "postgres://example.invalid/db" },
	};
	await withCoreStore(env, () => {
		expect(cmsQueryDb(d1)).toBe(scoped);
	});
});

it("keeps a raw D1 binding on D1 outside a Postgres scope", () => {
	const client = cmsQueryDb(d1);
	expect(client).not.toBe(d1);
	expect(typeof client.select).toBe("function");
});
