import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

let verifiedClaims: Record<string, unknown> = {};

vi.mock("@descope/node-sdk", () => ({
	default: () => ({
		validateSession: async () => ({ jwt: "token", token: verifiedClaims }),
	}),
}));

const { validateToken } = await import("./jwt");

const now = Math.floor(Date.now() / 1000);

describe("validateToken claim shaping", () => {
	beforeEach(() => {
		verifiedClaims = {};
	});

	it("keeps an absent audience absent instead of defaulting it", async () => {
		verifiedClaims = { sub: "U1", iss: "P_example", exp: now + 60 };

		const payload = await validateToken("token", {
			projectId: "P_example",
		});

		expect(payload.aud).toBeUndefined();
		expect(payload.iat).toBeUndefined();
		expect(payload.iss).toBe("P_example");
	});

	it("passes the issued audience and issue time through unchanged", async () => {
		verifiedClaims = {
			sub: "U1",
			iss: "P_example",
			iat: now - 5,
			exp: now + 60,
			aud: ["https://mcp.example.test/mcp", "P_example"],
		};

		const payload = await validateToken("token", {
			projectId: "P_example",
		});

		expect(payload.aud).toEqual(["https://mcp.example.test/mcp", "P_example"]);
		expect(payload.iat).toBe(now - 5);
	});

	it("drops a malformed audience rather than trusting it", async () => {
		verifiedClaims = { iss: "P_example", exp: now + 60, aud: [1, "x"] };

		const payload = await validateToken("token", {
			projectId: "P_example",
		});

		expect(payload.aud).toBeUndefined();
	});

	it("rejects verified claims without an issuer", async () => {
		verifiedClaims = { sub: "U1", exp: now + 60 };

		await expect(
			validateToken("token", { projectId: "P_example" }),
		).rejects.toMatchObject({ code: "CLAIM_VALIDATION_FAILED" });
	});
});
