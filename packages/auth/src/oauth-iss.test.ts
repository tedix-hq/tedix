import { describe, expect, it } from "vite-plus/test";
import {
	AuthorizationResponseIssError,
	assertAuthorizationResponseIss,
	assertPinnedIssuerMatches,
	IssuerPinDriftError,
	normalizeIssuerForComparison,
} from "./oauth-iss.ts";

const ISSUER = "https://auth.example.com";

describe("assertAuthorizationResponseIss — RFC 9207 decision table", () => {
	it("accepts when iss is present and equals the expected issuer", () => {
		const result = assertAuthorizationResponseIss({
			expectedIssuer: ISSUER,
			issSupported: true,
			responseIss: ISSUER,
		});
		expect(result).toEqual({ validated: true });
	});

	it("rejects when iss is present and differs from the expected issuer", () => {
		let thrown: unknown;
		try {
			assertAuthorizationResponseIss({
				expectedIssuer: ISSUER,
				issSupported: false,
				responseIss: "https://evil.example.com",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AuthorizationResponseIssError);
		const issError = thrown as AuthorizationResponseIssError;
		expect(issError.code).toBe("iss_mismatch");
		expect(issError.expectedIssuer).toBe(ISSUER);
		expect(issError.responseIss).toBe("https://evil.example.com");
		expect(issError.message).toContain("RFC 9207");
	});

	it("rejects when iss is absent and the AS advertises iss support", () => {
		let thrown: unknown;
		try {
			assertAuthorizationResponseIss({
				expectedIssuer: ISSUER,
				issSupported: true,
				responseIss: null,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AuthorizationResponseIssError);
		const issError = thrown as AuthorizationResponseIssError;
		expect(issError.code).toBe("iss_missing");
		expect(issError.responseIss).toBeNull();
	});

	it("accepts with a structured warning when iss is absent and the AS does not advertise support", () => {
		const result = assertAuthorizationResponseIss({
			expectedIssuer: ISSUER,
			issSupported: false,
			responseIss: undefined,
		});
		expect(result.validated).toBe(false);
		if (result.validated) throw new Error("unreachable");
		expect(result.warning.code).toBe("iss_absent_as_unsupported");
		expect(result.warning.message).toContain(ISSUER);
	});

	it("treats an empty-string iss as absent", () => {
		expect(() =>
			assertAuthorizationResponseIss({
				expectedIssuer: ISSUER,
				issSupported: true,
				responseIss: "",
			}),
		).toThrowError(AuthorizationResponseIssError);
		const result = assertAuthorizationResponseIss({
			expectedIssuer: ISSUER,
			issSupported: false,
			responseIss: "",
		});
		expect(result.validated).toBe(false);
	});
});

describe("assertAuthorizationResponseIss — byte-exact comparison", () => {
	it("rejects a trailing-slash difference in either direction", () => {
		for (const [expectedIssuer, responseIss] of [
			[`${ISSUER}/`, ISSUER],
			[ISSUER, `${ISSUER}/`],
		] as const) {
			expect(() =>
				assertAuthorizationResponseIss({
					expectedIssuer,
					issSupported: true,
					responseIss,
				}),
			).toThrowError(AuthorizationResponseIssError);
		}
	});

	it("is otherwise byte-exact: case differences mismatch", () => {
		expect(() =>
			assertAuthorizationResponseIss({
				expectedIssuer: ISSUER,
				issSupported: false,
				responseIss: "https://AUTH.example.com",
			}),
		).toThrowError(AuthorizationResponseIssError);
	});

	it("is byte-exact on scheme and path", () => {
		expect(() =>
			assertAuthorizationResponseIss({
				expectedIssuer: ISSUER,
				issSupported: false,
				responseIss: "http://auth.example.com",
			}),
		).toThrowError(AuthorizationResponseIssError);
		expect(() =>
			assertAuthorizationResponseIss({
				expectedIssuer: `${ISSUER}/tenant-a`,
				issSupported: false,
				responseIss: `${ISSUER}/tenant-b`,
			}),
		).toThrowError(AuthorizationResponseIssError);
	});

	it("keeps trailing-slash normalization isolated to discovery and pinning", () => {
		expect(normalizeIssuerForComparison("https://as.example.com///")).toBe(
			"https://as.example.com",
		);
		expect(normalizeIssuerForComparison("https://as.example.com/path/")).toBe(
			"https://as.example.com/path",
		);
		expect(normalizeIssuerForComparison("https://as.example.com/path")).toBe(
			"https://as.example.com/path",
		);
	});
});

describe("assertPinnedIssuerMatches — phase 1a issuer-pin drift", () => {
	it("is a no-op when no issuer is pinned (legacy row / first discovery)", () => {
		for (const pinnedIssuer of [null, undefined, ""]) {
			expect(() =>
				assertPinnedIssuerMatches({
					providerId: "linear",
					pinnedIssuer,
					discoveredIssuer: ISSUER,
				}),
			).not.toThrow();
		}
	});

	it("passes when the discovered issuer matches the pin", () => {
		expect(() =>
			assertPinnedIssuerMatches({
				providerId: "linear",
				pinnedIssuer: ISSUER,
				discoveredIssuer: ISSUER,
			}),
		).not.toThrow();
	});

	it("normalizes trailing slashes only, like the RFC 8414 discovery check", () => {
		expect(() =>
			assertPinnedIssuerMatches({
				providerId: "linear",
				pinnedIssuer: `${ISSUER}/`,
				discoveredIssuer: ISSUER,
			}),
		).not.toThrow();
	});

	it("throws a typed drift error when the discovered issuer differs", () => {
		let caught: unknown;
		try {
			assertPinnedIssuerMatches({
				providerId: "linear",
				pinnedIssuer: ISSUER,
				discoveredIssuer: "https://evil.example.com",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IssuerPinDriftError);
		const drift = caught as IssuerPinDriftError;
		expect(drift.code).toBe("issuer_pin_drift");
		expect(drift.providerId).toBe("linear");
		expect(drift.pinnedIssuer).toBe(ISSUER);
		expect(drift.discoveredIssuer).toBe("https://evil.example.com");
		expect(drift.message).toMatch(/Refusing to re-provision/);
	});

	it("is byte-exact beyond trailing slashes: path drift on the same origin refuses", () => {
		expect(() =>
			assertPinnedIssuerMatches({
				providerId: "linear",
				pinnedIssuer: `${ISSUER}/tenant-a`,
				discoveredIssuer: `${ISSUER}/tenant-b`,
			}),
		).toThrowError(IssuerPinDriftError);
	});
});
