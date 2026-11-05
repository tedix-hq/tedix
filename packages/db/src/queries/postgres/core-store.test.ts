import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { resolveCoreStore } from "./core-store";

describe("resolveCoreStore", () => {
	const platform = () =>
		createDbClient(createD1Facade(new DatabaseSync(":memory:")));

	it("binds the platform client when config selects platform-d1", () => {
		const db = platform();
		const binding = resolveCoreStore(
			{ plane: "platform-d1" },
			{ platform: db },
		);
		expect(binding).toEqual({ plane: "platform-d1", db });
	});

	it("binds the configured Postgres client", () => {
		const postgres = { dialect: "postgres" as const };
		const binding = resolveCoreStore(
			{ plane: "postgres" },
			{ platform: platform(), postgres },
		);
		expect(binding).toEqual({ plane: "postgres", db: postgres });
	});

	it("fails closed when Postgres is selected without a client", () => {
		expect(() =>
			resolveCoreStore({ plane: "postgres" }, { platform: platform() }),
		).toThrow("CORE_STORE_UNBOUND");
	});
});
