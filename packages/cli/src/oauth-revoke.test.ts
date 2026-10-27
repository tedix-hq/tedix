import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCredentialLock } from "./credential-lock";
import {
	readWorkspaceCredentials,
	type WorkspaceCredential,
	writeWorkspaceCredentials,
} from "./credential-store";
import { TEDIX_OAUTH_CLIENT_ID } from "./oauth-provider";
import {
	logoutMessage,
	logoutWorkspace,
	revokeWorkspaceGrant,
} from "./oauth-revoke";

const ISSUER = "https://auth.example.test/v1/apps/agentic/P1/RS1";
const REVOKE = "https://auth.example.test/oauth2/v1/apps/P1/revoke";

function credential(
	overrides: Partial<WorkspaceCredential> = {},
	revocationEndpoint: string | null = REVOKE,
): WorkspaceCredential {
	return {
		loginId: "user",
		oauthTokens: {
			access_token: "access",
			refresh_token: "refresh-1",
			token_type: "Bearer",
		},
		oauthClientInformation: { client_id: TEDIX_OAUTH_CLIENT_ID },
		oauthDiscoveryState: {
			authorizationServerUrl: ISSUER,
			authorizationServerMetadata: {
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				response_types_supported: ["code"],
				...(revocationEndpoint
					? { revocation_endpoint: revocationEndpoint }
					: {}),
			},
		},
		...overrides,
	};
}

function recordingFetch(status = 200) {
	const calls: Array<{ url: string; body: URLSearchParams }> = [];
	const fetchFn = async (input: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			body: new URLSearchParams(String(init?.body)),
		});
		return new Response(null, { status });
	};
	return { calls, fetchFn };
}

describe("revokeWorkspaceGrant", () => {
	test("revokes the refresh token at the endpoint recorded at login", async () => {
		const { calls, fetchFn } = recordingFetch();
		expect(await revokeWorkspaceGrant(credential(), { fetchFn })).toBe(
			"revoked",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(REVOKE);
		expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
			token: "refresh-1",
			token_type_hint: "refresh_token",
			client_id: TEDIX_OAUTH_CLIENT_ID,
		});
	});

	test.each([
		["no refresh token", credential({ oauthTokens: undefined })],
		["an invalidated family", credential({ oauthRefreshInvalidated: true })],
	])("sends nothing for %s", async (_label, stored) => {
		const { calls, fetchFn } = recordingFetch();
		expect(await revokeWorkspaceGrant(stored, { fetchFn })).toBe("no-grant");
		expect(calls).toHaveLength(0);
	});

	test.each([
		["no advertised endpoint", credential({}, null)],
		["a non-HTTPS endpoint", credential({}, "http://auth.example.test/revoke")],
		["no client id", credential({ oauthClientInformation: undefined })],
	])("never guesses an endpoint: %s", async (_label, stored) => {
		const { calls, fetchFn } = recordingFetch();
		expect(await revokeWorkspaceGrant(stored, { fetchFn })).toBe("unsupported");
		expect(calls).toHaveLength(0);
	});

	test("reports a rejected or unreachable revocation as failed", async () => {
		expect(
			await revokeWorkspaceGrant(credential(), {
				fetchFn: recordingFetch(503).fetchFn,
			}),
		).toBe("failed");
		expect(
			await revokeWorkspaceGrant(credential(), {
				fetchFn: async () => {
					throw new Error("offline");
				},
			}),
		).toBe("failed");
	});

	test("does not forward the refresh token through redirects or accept a queued response", async () => {
		for (const status of [202, 307]) {
			expect(
				await revokeWorkspaceGrant(credential(), {
					fetchFn: async (_input, init) => {
						expect(init?.redirect).toBe("error");
						return new Response(null, { status });
					},
				}),
			).toBe("failed");
		}
	});

	test("bounds an unresponsive revocation request", async () => {
		expect(
			await revokeWorkspaceGrant(credential(), {
				timeoutMs: 5,
				fetchFn: async (_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason),
							{ once: true },
						);
					}),
			}),
		).toBe("failed");
	});
});

describe("logoutWorkspace", () => {
	let previous: string | undefined;
	let dir: string;
	beforeEach(() => {
		previous = process.env.TEDIX_CONFIG_DIR;
		dir = mkdtempSync(join(tmpdir(), "tedix-logout-revoke-"));
		process.env.TEDIX_CONFIG_DIR = dir;
	});
	afterEach(() => {
		if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
		else process.env.TEDIX_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	test("revokes the token stored after a concurrent renewal, then removes the login", async () => {
		writeWorkspaceCredentials("acme", credential());
		// A renewal holds the lock and rotates the token before logout reads it.
		const renewal = await acquireCredentialLock("acme");
		const { calls, fetchFn } = recordingFetch();
		const logout = logoutWorkspace("acme", { fetchFn });
		const stored = readWorkspaceCredentials("acme");
		writeWorkspaceCredentials(
			"acme",
			credential({
				oauthTokens: {
					access_token: "access-2",
					refresh_token: "refresh-2",
					token_type: "Bearer",
				},
			}),
			undefined,
			stored ?? undefined,
		);
		renewal?.release();
		expect(await logout).toBe("revoked");
		expect(calls.map((call) => call.body.get("token"))).toEqual(["refresh-2"]);
		expect(readWorkspaceCredentials("acme")).toBeNull();
	});

	test("removes the login even when revocation fails", async () => {
		writeWorkspaceCredentials("acme", credential());
		expect(
			await logoutWorkspace("acme", { fetchFn: recordingFetch(500).fetchFn }),
		).toBe("failed");
		expect(readWorkspaceCredentials("acme")).toBeNull();
	});

	test("keeps credentials when a renewal still holds the lock", async () => {
		writeWorkspaceCredentials("acme", credential());
		const renewal = await acquireCredentialLock("acme");
		const { calls, fetchFn } = recordingFetch();
		try {
			await expect(
				logoutWorkspace("acme", { fetchFn, lockWaitMs: 0 }),
			).rejects.toThrow("credentials were kept");
			expect(readWorkspaceCredentials("acme")?.oauthTokens?.refresh_token).toBe(
				"refresh-1",
			);
			expect(calls).toHaveLength(0);
		} finally {
			renewal?.release();
		}
	});

	test("a missing login is not an error", async () => {
		expect(await logoutWorkspace("absent")).toBe("no-grant");
	});

	test("logout --all reports unsupported revocation and clears each local login", async () => {
		writeWorkspaceCredentials("acme", credential({}, null));
		writeWorkspaceCredentials("other", credential({ oauthTokens: undefined }));
		const child = Bun.spawn(
			[process.execPath, `${import.meta.dir}/index.ts`, "logout", "--all"],
			{
				env: { ...process.env, TEDIX_CONFIG_DIR: dir },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		expect(stderr).toContain('Warning: removed workspace "acme" locally');
		expect(stdout).toContain('Logged out of workspace "other".');
		expect(readWorkspaceCredentials("acme")).toBeNull();
		expect(readWorkspaceCredentials("other")).toBeNull();
	}, 20_000);
});

test("failed and unsupported revocations are phrased as warnings", () => {
	expect(logoutMessage("acme", "revoked")).toContain("revoked its sign-in");
	expect(logoutMessage("acme", "failed")).toStartWith("Warning:");
	expect(logoutMessage("acme", "unsupported")).toStartWith("Warning:");
	expect(logoutMessage("acme", "no-grant")).toBe(
		'Logged out of workspace "acme".',
	);
});
