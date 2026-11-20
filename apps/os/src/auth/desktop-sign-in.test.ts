// @vitest-environment node
import { validateToken } from "@tedix/auth/jwt";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleDesktopSignIn } from "./desktop-sign-in";
import { OS_BROKER_SESSION_COOKIE } from "./session-broker";

vi.mock("@tedix/auth/jwt", () => ({ validateToken: vi.fn() }));

const validate = vi.mocked(validateToken);
const key = "k".repeat(87);
const apiFetch = vi.fn<(request: Request) => Promise<Response>>();
const env = {
	API_SERVICE: { fetch: apiFetch },
	DESCOPE_PROJECT_ID: "project",
};

function post(body: Record<string, unknown>): Request {
	return new Request("https://acme.os.tedix.dev/auth/desktop/sign-in", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "https://acme.os.tedix.dev",
			Cookie: `${OS_BROKER_SESSION_COOKIE}=browser-jwt`,
		},
		body: JSON.stringify(body),
	});
}

describe("desktop sign-in code", () => {
	beforeEach(() => {
		validate.mockReset();
		apiFetch.mockReset();
		const claims = { exp: Math.floor(Date.now() / 1000) + 600, iss: "project" };
		validate.mockImplementation(async (token) =>
			token === "su-jwt"
				? { ...claims, sub: "user-1", su: true }
				: token === "other-su-jwt"
					? { ...claims, sub: "user-2", su: true }
					: { ...claims, sub: "user-1" },
		);
		apiFetch.mockResolvedValue(Response.json({ code: "sealed-code" }));
	});

	it.each([
		["no fresh sign-in", {}],
		["a token without the step-up claim", { steppedUpToken: "plain-jwt" }],
		["a fresh sign-in by someone else", { steppedUpToken: "other-su-jwt" }],
	])("refuses %s without asking the API", async (_, extra) => {
		const response = await handleDesktopSignIn(post({ key, ...extra }), env);
		expect(response?.status).toBe(403);
		expect(apiFetch).not.toHaveBeenCalled();
	});

	it("sends the stepped-up token, not the browser session, to the API", async () => {
		const response = await handleDesktopSignIn(
			post({ key, steppedUpToken: "su-jwt" }),
			env,
		);
		expect(await response?.json()).toEqual({ code: "sealed-code" });
		const sent = apiFetch.mock.calls[0]?.[0] as Request;
		expect(await sent.json()).toEqual({ session: "su-jwt", key });
	});
});
