import { describe, expect, test } from "bun:test";
import { decodeJwtPayload } from "./jwt-payload";

function tokenFor(value: unknown): string {
	return `header.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
}

describe("decodeJwtPayload", () => {
	test.each([
		{},
		{ sub: "fictional-user", exp: 123, roles: ["reader"] },
		{ name: "Grüße 世界 🦊", nested: { values: [true, null, 42] } },
	])("decodes a base64url object payload: %j", (claims) => {
		expect(decodeJwtPayload(tokenFor(claims))).toEqual(claims);
	});

	test.each(["x", "xx", "xxx"])(
		"accepts optional base64 padding for %s",
		(value) => {
			const claims = { value };
			const payload = Buffer.from(JSON.stringify(claims)).toString("base64");
			const base64url = payload.replace(/\+/g, "-").replace(/\//g, "_");
			expect(decodeJwtPayload(`header.${base64url}.signature`)).toEqual(claims);
			expect(
				decodeJwtPayload(`header.${base64url.replace(/=+$/, "")}.signature`),
			).toEqual(claims);
		},
	);

	test.each(
		[null, true, false, 0, 42, -1.5, "", "metadata", [], [{}]].map((value) => ({
			value,
		})),
	)("rejects a non-object JSON root: %j", ({ value }) => {
		expect(decodeJwtPayload(tokenFor(value))).toBeNull();
	});

	test.each([
		"",
		"header",
		"header..signature",
		"header.%%%!.signature",
		"header.a.signature",
	])("returns null for a missing or invalid base64 payload: %s", (token) => {
		expect(decodeJwtPayload(token)).toBeNull();
	});

	test.each(["", "not JSON", "{", '{"sub":}', '{"sub":"user"} trailing'])(
		"returns null for invalid JSON: %j",
		(payload) => {
			const encoded = Buffer.from(payload).toString("base64url");
			expect(decodeJwtPayload(`header.${encoded}.signature`)).toBeNull();
		},
	);
});
