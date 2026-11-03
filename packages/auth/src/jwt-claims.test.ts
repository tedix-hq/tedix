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

describe("validateToken claims audit", () => {
	beforeEach(() => {
		verifiedClaims = {};
	});

	it("reports what strict audience and issuer checks would do", async () => {
		verifiedClaims = {
			sub: "U1",
			iss: "P_example",
			exp: now + 60,
			aud: "https://other.tedix.dev",
		};
		const seen: unknown[] = [];

		const payload = await validateToken("token", {
			projectId: "P_example",
			auditClaims: {
				surface: "test:surface",
				expected: ["https://api.tedix.dev"],
				report: (event) => seen.push(event),
			},
		});

		expect(payload.sub).toBe("U1");
		expect(seen).toEqual([
			{
				surface: "test:surface",
				expectedAudiences: ["https://api.tedix.dev"],
				actualAudiences: ["https://other.tedix.dev"],
				wouldRejectAudience: true,
				passedOnlyViaProjectId: false,
				missingAudienceClaim: false,
				expectedIssuer: "P_example",
				actualIssuer: "P_example",
				wouldRejectIssuer: false,
				wouldReject: true,
			},
		]);
	});

	it("accepts the token even when the audit would have rejected it", async () => {
		verifiedClaims = {
			sub: "U1",
			iss: "https://api.descope.com/v1/apps/agentic/P_example/RSconnect",
			exp: now + 60,
			aud: ["CI_client", "P_example"],
		};
		const seen: unknown[] = [];

		const payload = await validateToken("token", {
			projectId: "P_example",
			auditClaims: {
				surface: "test:surface",
				expected: ["P_example"],
				report: (event) => seen.push(event),
			},
		});

		expect(payload.sub).toBe("U1");
		expect(seen).toMatchObject([
			{
				wouldRejectAudience: false,
				wouldRejectIssuer: true,
				wouldReject: true,
			},
		]);
	});

	it("never lets a throwing reporter fail validation", async () => {
		verifiedClaims = { sub: "U1", iss: "P_example", exp: now + 60 };

		const payload = await validateToken("token", {
			projectId: "P_example",
			auditClaims: {
				surface: "test:surface",
				expected: ["P_example"],
				report: () => {
					throw new Error("reporter exploded");
				},
			},
		});

		expect(payload.sub).toBe("U1");
	});

	it("emits nothing when the caller did not ask for an audit", async () => {
		verifiedClaims = { sub: "U1", iss: "P_example", exp: now + 60 };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await validateToken("token", { projectId: "P_example" });
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
