import { describe, expect, it } from "vite-plus/test";
import {
	KERNEL_WS_TOKEN_SCOPE,
	KERNEL_WS_TOKEN_TTL_SECONDS,
	KERNEL_WS_TOKEN_VERSION,
	mintKernelWsToken,
	signKernelWsTokenPayload,
	verifyKernelWsToken,
} from "./ws-token";

const SECRET = "test-platform-service-token";
const ORG = "11111111-2222-3333-4444-555555555555";
const USER = "U2abcdef0123456789";

function basePayload(overrides: Record<string, unknown> = {}) {
	return {
		v: KERNEL_WS_TOKEN_VERSION,
		scope: KERNEL_WS_TOKEN_SCOPE,
		organizationId: ORG,
		descopeUserId: USER,
		exp: Math.floor(Date.now() / 1000) + 600,
		...overrides,
	};
}

describe("mintKernelWsToken / verifyKernelWsToken", () => {
	it("round-trips: mint → verify returns the trusted payload", async () => {
		const now = Date.now();
		const minted = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: USER,
			platformServiceToken: SECRET,
			now,
		});

		expect(minted.expiresAt).toBe(
			(Math.floor(now / 1000) + KERNEL_WS_TOKEN_TTL_SECONDS) * 1000,
		);
		// Two-segment compact format — never confusable with a 3-segment JWT.
		expect(minted.token.split(".")).toHaveLength(2);

		const verified = await verifyKernelWsToken(minted.token, SECRET, now);
		expect(verified).toMatchObject({
			v: KERNEL_WS_TOKEN_VERSION,
			scope: KERNEL_WS_TOKEN_SCOPE,
			organizationId: ORG,
			descopeUserId: USER,
		});
	});

	it("rejects an expired token", async () => {
		const now = Date.now();
		const minted = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: USER,
			platformServiceToken: SECRET,
			now,
		});
		const afterExpiry = now + (KERNEL_WS_TOKEN_TTL_SECONDS + 1) * 1000;
		expect(await verifyKernelWsToken(minted.token, SECRET, afterExpiry)).toBe(
			null,
		);
		// Boundary: exp is exclusive (exp*1000 <= now fails).
		expect(
			await verifyKernelWsToken(minted.token, SECRET, minted.expiresAt),
		).toBe(null);
	});

	it("rejects a tampered payload (signature no longer matches)", async () => {
		const minted = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: USER,
			platformServiceToken: SECRET,
		});
		const [, signature] = minted.token.split(".");
		const forgedPayload = btoa(
			JSON.stringify(basePayload({ organizationId: "attacker-org" })),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(
			await verifyKernelWsToken(`${forgedPayload}.${signature}`, SECRET),
		).toBe(null);
	});

	it("rejects a tampered signature", async () => {
		const minted = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: USER,
			platformServiceToken: SECRET,
		});
		const [payload, signature] = minted.token.split(".");
		const flipped = signature?.startsWith("A")
			? `B${signature?.slice(1)}`
			: `A${signature?.slice(1)}`;
		expect(await verifyKernelWsToken(`${payload}.${flipped}`, SECRET)).toBe(
			null,
		);
	});

	it("rejects a token signed with a different platform service token", async () => {
		const minted = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: USER,
			platformServiceToken: "some-other-secret",
		});
		expect(await verifyKernelWsToken(minted.token, SECRET)).toBe(null);
	});

	it("rejects a validly-signed token with the wrong scope", async () => {
		const token = await signKernelWsTokenPayload(
			basePayload({ scope: "gateway:ws" }),
			SECRET,
		);
		expect(await verifyKernelWsToken(token, SECRET)).toBe(null);
	});

	it("rejects a validly-signed token with the wrong version", async () => {
		const token = await signKernelWsTokenPayload(basePayload({ v: 2 }), SECRET);
		expect(await verifyKernelWsToken(token, SECRET)).toBe(null);
	});

	it("rejects validly-signed tokens missing identity claims", async () => {
		expect(
			await verifyKernelWsToken(
				await signKernelWsTokenPayload(
					basePayload({ organizationId: "" }),
					SECRET,
				),
				SECRET,
			),
		).toBe(null);
		expect(
			await verifyKernelWsToken(
				await signKernelWsTokenPayload(
					basePayload({ descopeUserId: undefined }),
					SECRET,
				),
				SECRET,
			),
		).toBe(null);
	});

	it("returns null for garbage and JWT-shaped strings (never throws)", async () => {
		expect(await verifyKernelWsToken("", SECRET)).toBe(null);
		expect(await verifyKernelWsToken("not-a-token", SECRET)).toBe(null);
		expect(await verifyKernelWsToken("a.b.c", SECRET)).toBe(null); // 3-segment JWT shape
		expect(await verifyKernelWsToken("!!!.???", SECRET)).toBe(null); // non-base64url
		expect(await verifyKernelWsToken("a.", SECRET)).toBe(null);
		expect(await verifyKernelWsToken(".b", SECRET)).toBe(null);
	});

	it("returns null when the signing secret is empty (fail closed)", async () => {
		const minted = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: USER,
			platformServiceToken: SECRET,
		});
		expect(await verifyKernelWsToken(minted.token, "")).toBe(null);
	});
});
