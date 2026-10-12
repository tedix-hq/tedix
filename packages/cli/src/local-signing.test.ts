import { describe, expect, test } from "bun:test";
import {
	hasLocalSigningIdentity,
	LOCAL_SIGNING_IDENTIFIER,
	LOCAL_SIGNING_IDENTITY,
	signedLocally,
	signLocally,
} from "./local-signing";

describe("local signing", () => {
	test("finds only the named identity, and only on macOS", () => {
		const listed = () => ({
			status: 0,
			output: `  1) 90DC "${LOCAL_SIGNING_IDENTITY}" (CSSMERR_TP_NOT_TRUSTED)\n`,
		});
		expect(hasLocalSigningIdentity(listed, "darwin")).toBe(true);
		expect(hasLocalSigningIdentity(listed, "linux")).toBe(false);
		expect(
			hasLocalSigningIdentity(
				() => ({ status: 0, output: '  1) 12AB "Someone Else"\n' }),
				"darwin",
			),
		).toBe(false);
	});

	test("reads the stable identifier and signs with it", () => {
		expect(
			signedLocally("/x", () => ({
				status: 0,
				output: `designated => identifier "${LOCAL_SIGNING_IDENTIFIER}" and certificate leaf = H"ab"`,
			})),
		).toBe(true);
		expect(
			signedLocally("/x", () => ({
				status: 0,
				output: 'designated => cdhash H"ab"',
			})),
		).toBe(false);
		const calls: string[][] = [];
		signLocally("/x", (command, args) => {
			calls.push([command, ...args]);
			return { status: 0, output: "" };
		});
		expect(calls).toEqual([
			[
				"codesign",
				"--force",
				"--sign",
				LOCAL_SIGNING_IDENTITY,
				"--identifier",
				LOCAL_SIGNING_IDENTIFIER,
				"/x",
			],
		]);
		expect(() =>
			signLocally("/x", () => ({ status: 1, output: "no identity found" })),
		).toThrow("no identity found");
	});
});
