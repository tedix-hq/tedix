import { describe, expect, it } from "vite-plus/test";
import {
	connectionAccountMode,
	resolveConnectionAccountPolicy,
} from "./connection-account-mode";

describe("connectionAccountMode", () => {
	it.each([
		["api_key", null, "single", ["single"]],
		["oauth", "cimd", "single", ["single"]],
		["oauth", "pre_registered", "single", ["single", "multiple"]],
		["oauth", "dcr", "multiple", ["single", "multiple"]],
		["oauth", null, "multiple", ["single", "multiple"]],
	] as const)(
		"%s / %s configured for %s accounts",
		(type, registration, mode, availableAccountModes) => {
			const result = connectionAccountMode({
				connectionType: type,
				registrationMode: registration,
				accountMode: mode,
				availableAccountModes: [...availableAccountModes],
			});
			expect(result.mode).toBe(mode);
			expect(result.reason).not.toMatch(/oauth|cimd|dcr|token vault/i);
		},
	);
});

describe("resolveConnectionAccountPolicy", () => {
	it("defaults compatible OAuth providers to several accounts", () => {
		expect(
			resolveConnectionAccountPolicy({
				connectionType: "oauth",
				registrationMode: "pre_registered",
			}),
		).toEqual({
			accountMode: "multiple",
			availableAccountModes: ["single", "multiple"],
		});
	});

	it("honors an organization setting that narrows OAuth to one account", () => {
		expect(
			resolveConnectionAccountPolicy(
				{ connectionType: "oauth", registrationMode: "dcr" },
				"single",
			),
		).toMatchObject({ accountMode: "single" });
	});

	it.each([
		["api_key", null],
		["oauth", "cimd"],
	] as const)(
		"keeps %s / %s single even with invalid stored drift",
		(type, mode) => {
			expect(
				resolveConnectionAccountPolicy(
					{ connectionType: type, registrationMode: mode },
					"multiple",
				),
			).toEqual({
				accountMode: "single",
				availableAccountModes: ["single"],
			});
		},
	);
});
