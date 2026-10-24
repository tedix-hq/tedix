import { describe, expect, it } from "vite-plus/test";
import { connectionAccountMode } from "./connection-account-mode";

describe("connectionAccountMode", () => {
	it.each([
		["api_key", null, "single"],
		["oauth", "cimd", "single"],
		["oauth", "pre_registered", "multiple"],
		["oauth", "dcr", "multiple"],
		["oauth", null, "multiple"],
	] as const)("%s / %s allows %s accounts", (type, registration, mode) => {
		const result = connectionAccountMode({
			connectionType: type,
			registrationMode: registration,
		});
		expect(result.mode).toBe(mode);
		expect(result.reason).not.toMatch(/oauth|cimd|dcr|token vault/i);
	});
});
