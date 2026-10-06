import { describe, expect, test } from "vite-plus/test";
import {
	assertFleetAuthorityAvailable,
	fleetAuthorityIsEnabled,
	FleetAuthorityUnavailableError,
	resolveFleetAuthorityBinding,
	resolveFleetAuthorityMode,
} from "./fleet-authority";

const db = {} as D1Database;

describe("fleet authority", () => {
	test("requires an explicit valid mode", () => {
		for (const mode of [undefined, "", "managed", "service"]) {
			expect(() =>
				resolveFleetAuthorityMode({ TEDIX_FLEET_AUTHORITY_MODE: mode }),
			).toThrow(/TEDIX_FLEET_AUTHORITY_MODE/);
		}
	});

	test("disabled fails closed without inspecting a database binding", () => {
		const env = {
			TEDIX_FLEET_AUTHORITY_MODE: "disabled",
			get DB(): D1Database {
				throw new Error("tenant DB must not be read");
			},
		};
		expect(fleetAuthorityIsEnabled(env)).toBe(false);
		expect(() => resolveFleetAuthorityBinding(env)).toThrowError(
			FleetAuthorityUnavailableError,
		);
	});

	test("co-located explicitly uses DB", () => {
		expect(
			resolveFleetAuthorityBinding({
				TEDIX_FLEET_AUTHORITY_MODE: "co-located",
				DB: db,
			}),
		).toBe(db);
		expect(() =>
			assertFleetAuthorityAvailable({
				TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			}),
		).toThrow(/requires DB/);
	});
});
