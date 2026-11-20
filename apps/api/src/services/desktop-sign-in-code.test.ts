import { expect, it, vi } from "vite-plus/test";

const generateEmbeddedLink = vi.fn(async () => ({
	ok: true,
	data: { token: "one-time" },
}));
vi.mock("@tedix/auth/jwt", () => ({
	// Each test token is its own claims, so no signing is needed here.
	validateToken: async (token: string) => JSON.parse(token),
}));
vi.mock("@tedix/auth/client", () => ({
	getManagementClient: () => ({
		management: {
			user: {
				loadByUserId: async () => ({
					ok: true,
					data: { loginIds: ["person@example.test"] },
				}),
				generateEmbeddedLink,
			},
		},
	}),
}));
vi.mock("@tedix/auth/desktop-sign-in-code", () => ({
	DESKTOP_SIGN_IN_KEY_PATTERN: /^[A-Za-z0-9_-]{87}$/,
	sealDesktopSignInCode: async () => "sealed",
}));

import { desktopSignInCode } from "./desktop-sign-in-code";

const env = {
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_MANAGEMENT_KEY: "key",
	DESCOPE_BASE_URL: undefined,
} as never;

const ask = (proof: Record<string, unknown>) =>
	desktopSignInCode(
		new Request("https://api/__internal/desktop-sign-in-code", {
			method: "POST",
			body: JSON.stringify({
				session: JSON.stringify({ sub: "person" }),
				proof: JSON.stringify(proof),
				key: "k".repeat(87),
			}),
		}),
		env,
	);

it("issues a desktop sign-in code only after the same person confirmed who they are", async () => {
	// An ordinary session, and someone else's confirmation, issue nothing.
	expect((await ask({ sub: "person" })).status).toBe(403);
	expect((await ask({ sub: "someone-else", su: true })).status).toBe(403);
	expect(generateEmbeddedLink).not.toHaveBeenCalled();

	const issued = await ask({ sub: "person", su: true });
	expect(await issued.json()).toEqual({ code: "sealed" });
});
