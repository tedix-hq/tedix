import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	confirmStoredAccess,
	loginRecoveryKey,
	readLoginRecovery,
	saveLoginRecovery,
	verifyStoredAccess,
} from "./login-recovery";
import { resolveStoredLoginAuth } from "./auth-resolve";
import {
	readWorkspaceCredentials,
	writeWorkspaceCredentials,
	type WorkspaceCredential,
} from "./credential-store";
import {
	renewStoredSession,
	WorkspaceOAuthProvider,
	refreshStoredSession,
} from "./oauth-provider";
import { LaneDispatcher, type ServeOptions } from "./lane-serve";

let dir: string;
let previous: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tedix-login-recovery-"));
	previous = process.env.TEDIX_CONFIG_DIR;
	process.env.TEDIX_CONFIG_DIR = dir;
});
afterEach(() => {
	if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
	else process.env.TEDIX_CONFIG_DIR = previous;
	rmSync(dir, { recursive: true, force: true });
});
const login = (): WorkspaceCredential => ({
	loginId: "fixture-owner",
	mcpUrl: "https://fixture.example/mcp",
	org: "org_fixture",
	oauthRefreshPending: true,
	accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 80,
	oauthTokens: {
		access_token: "fixture-access",
		refresh_token: "fixture-refresh",
		token_type: "Bearer",
	},
});

test("an uncertain login uses only a confirmed access token and keeps the refresh fence", async () => {
	const credential = login();
	writeWorkspaceCredentials("fixture", credential);
	const provider = new WorkspaceOAuthProvider({
		workspace: "fixture",
		mcpUrl: credential.mcpUrl!,
		credential,
	});
	expect(
		await renewStoredSession(provider, { command: ["must-not-spawn", []] }),
	).toBe("uncertain");
	let probes = 0;
	for (let n = 0; n < 2; n++) {
		const result = await resolveStoredLoginAuth("fixture", {
			verifyAccess: async () => {
				probes++;
				return "usable";
			},
		});
		expect(result.auth?.headers).toEqual({
			Authorization: "Bearer fixture-access",
		});
		expect(result.auth?.oauthProvider).toBeUndefined();
	}
	expect(probes).toBe(1);
	expect(readWorkspaceCredentials("fixture")?.oauthRefreshPending).toBe(true);
});

test("a replacement saved by a sibling is adopted without probing or replay", async () => {
	const credential = login();
	writeWorkspaceCredentials("fixture", credential);
	const result = await resolveStoredLoginAuth("fixture", {
		refreshSession: async () => {
			writeWorkspaceCredentials("fixture", {
				...credential,
				oauthRefreshPending: undefined,
				accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 600,
				oauthTokens: {
					...credential.oauthTokens!,
					access_token: "replacement",
					refresh_token: "rotated",
				},
			});
			return "uncertain";
		},
		verifyAccess: async () => {
			throw new Error("must not probe");
		},
	});
	expect((await result.auth?.oauthProvider?.tokens())?.access_token).toBe(
		"replacement",
	);
});

test("concurrent checks and restarts share rejection until the exact login changes", async () => {
	const credential = login();
	let probes = 0;
	const verify = async () => {
		probes++;
		await Bun.sleep(10);
		return "rejected" as const;
	};
	expect(
		await Promise.all(
			Array.from({ length: 8 }, () =>
				confirmStoredAccess("fixture", credential, verify),
			),
		),
	).toEqual(Array(8).fill("rejected"));
	expect(probes).toBe(1);
	const key = loginRecoveryKey("fixture", credential);
	expect(
		readFileSync(join(dir, "login-recovery", `${key}.json`), "utf8"),
	).not.toContain("fixture-refresh");
	await confirmStoredAccess("fixture", credential, verify);
	expect(probes).toBe(1);
	await confirmStoredAccess(
		"fixture",
		{
			...credential,
			oauthTokens: { ...credential.oauthTokens!, refresh_token: "new-login" },
		},
		verify,
	);
	expect(probes).toBe(2);
});

test("an unavailable verification is temporary and never asks for sign-in", async () => {
	writeWorkspaceCredentials("fixture", login());
	let probes = 0;
	const verifyAccess = async () => {
		probes++;
		return "unknown" as const;
	};
	for (let n = 0; n < 3; n++) {
		const result = await resolveStoredLoginAuth("fixture", { verifyAccess });
		expect(result.auth).toBeNull();
		expect(result.loginError).toContain("temporarily unavailable");
		expect(result.loginError).not.toContain("tedix login");
	}
	expect(probes).toBe(1);
	const key = loginRecoveryKey("fixture", login());
	saveLoginRecovery(key, { status: "unknown", checkedAt: Date.now() - 61_000 });
	await resolveStoredLoginAuth("fixture", { verifyAccess });
	expect(probes).toBe(2);
});

for (const status of [200, 401, 503])
	test(`access confirmation handles HTTP ${status} without sending a refresh token`, async () => {
		let reads = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				expect(request.headers.get("authorization")).toBe(
					"Bearer fixture-access",
				);
				const raw = await request.text();
				expect(raw).not.toContain("fixture-refresh");
				if (status !== 200) return new Response("unavailable", { status });
				const body = JSON.parse(raw);
				let result: unknown;
				if (body.method === "server/discover")
					result = { supportedVersions: ["2026-07-28"] };
				else {
					reads++;
					const code = body.params.arguments.code;
					result = {
						resultType: "complete",
						structuredContent: {
							result: code.includes("discover.search")
								? [
										{
											tool: "list_all_mine",
											callable: "fixture.list_all_mine",
											authorized: true,
											schemaFreshness: {
												sourceRef: "organizations/listAllMine",
											},
										},
									]
								: [
										{
											organizationId: "org-id",
											organizationSlug: "fixture",
											descopeTenantId: "org_fixture",
										},
									],
						},
					};
				}
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		});
		try {
			expect(
				await verifyStoredAccess({ ...login(), mcpUrl: server.url.href }),
			).toBe(
				status === 200 ? "usable" : status === 401 ? "rejected" : "unknown",
			);
			if (status === 200) expect(reads).toBe(2);
		} finally {
			server.stop(true);
		}
	});

test("inherited lock-phase uncertainty does not bury the original renewal journal", async () => {
	const credential = login();
	writeWorkspaceCredentials("fixture", credential);
	const path = join(dir, "renewals.log");
	writeFileSync(path, "original sent-phase timeout\n");
	const provider = new WorkspaceOAuthProvider({
		workspace: "fixture",
		mcpUrl: credential.mcpUrl!,
		credential,
	});
	for (let n = 0; n < 3; n++)
		expect(await refreshStoredSession(provider)).toBe("uncertain");
	expect(readFileSync(path, "utf8")).toBe("original sent-phase timeout\n");
});

test("an expired preflight deadline cannot fence a refresh POST that was never sent", async () => {
	const origin = "https://auth.fixture.example";
	const credential: WorkspaceCredential = {
		...login(),
		oauthRefreshPending: undefined,
		oauthClientInformation: { client_id: "fixture-client" },
		oauthDiscoveryState: { authorizationServerUrl: origin },
	};
	writeWorkspaceCredentials("fixture", credential);
	const provider = new WorkspaceOAuthProvider({
		workspace: "fixture",
		mcpUrl: credential.mcpUrl!,
		credential,
	});
	Object.defineProperty(provider, "addClientAuthentication", {
		value: async () => {
			await Bun.sleep(30);
		},
	});
	let posts = 0;
	const outcome = await refreshStoredSession(provider, {
		timeoutMs: 10,
		isDarkWake: () => false,
		fetchFn: async (_input, init) => {
			if (init?.method === "POST") posts++;
			await Bun.sleep(30);
			return Response.json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				response_types_supported: ["code"],
			});
		},
	});
	expect(outcome).toBe("failed");
	expect(posts).toBe(0);
	expect(
		readWorkspaceCredentials("fixture")?.oauthRefreshPending,
	).toBeUndefined();
});

test.each([false, true])(
	"dispatchers keep one sign-in Decision across restart and new login (lost reply: %s)",
	async (lostReply) => {
		const credential = login();
		writeWorkspaceCredentials("fixture", credential);
		const options: ServeOptions = {
			executor: "codex",
			coordinated: false,
			acceptProposed: false,
			max: 1,
			rules: "lane-rules",
			repo: "/fixture",
			scope: ["--workspace", "fixture", "--organization", "org_fixture"],
			once: true,
			install: false,
		};
		const receipt = {
			itemId: "22222222-2222-4222-8222-222222222222",
			version: 1,
			phase: "running",
			session: "codex:fixture",
			executorKey: "fixture-principal",
			attemptId: "fixture-attempt",
		};
		writeFileSync(join(dir, "receipt.json"), JSON.stringify(receipt));
		let decisions = 0;
		const creates: string[] = [];
		let reads = 0;
		const deps: NonNullable<ConstructorParameters<typeof LaneDispatcher>[2]> = {
			darkWake: () => false,
			confirmLogin: (workspace, cred) =>
				confirmStoredAccess(workspace, cred, async () => "rejected"),
			budgets: () => ({}),
			available: () => false,
			gatewayCooldownUntil: () => 0,
			cli: async <T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> => {
				if (args.includes("interaction-create")) {
					decisions++;
					creates.push(
						JSON.stringify({
							args,
							session: env.TEDIX_AGENT_SESSION,
							executor: env.TEDIX_EXTERNAL_AGENT,
						}),
					);
					expect(env.TEDIX_AGENT_SESSION).toBe(receipt.session);
					expect(env.TEDIX_EXTERNAL_AGENT).toBe(receipt.executorKey);
					const input = JSON.parse(args[args.indexOf("--input") + 1]!);
					expect(input.requestedFrom).toEqual({
						type: "user",
						id: "fixture-owner",
					});
					if (lostReply && creates.length === 1)
						throw new Error("Decision saved; response lost");
					return { id: "decision-id" } as T;
				}
				reads++;
				return { data: [], pagination: { hasMore: false } } as T;
			},
		};
		const results = await Promise.allSettled([
			new LaneDispatcher(options, dir, deps).tick(),
			new LaneDispatcher(options, dir, deps).tick(),
		]);
		if (lostReply)
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
		await new LaneDispatcher(options, dir, deps).tick();
		expect(decisions).toBe(1);
		expect(reads).toBe(0);
		if (lostReply) {
			const key = loginRecoveryKey("fixture", credential);
			const state = readLoginRecovery(key)!;
			saveLoginRecovery(key, { ...state, notifyAfter: 0 });
			await new LaneDispatcher(options, dir, deps).tick();
			expect(creates).toHaveLength(2);
			expect(creates[1]).toBe(creates[0]);
			expect(readLoginRecovery(key)?.decision?.requestId).toBe("decision-id");
		}
		writeWorkspaceCredentials("fixture", {
			...credential,
			oauthRefreshPending: undefined,
			oauthTokens: { ...credential.oauthTokens!, refresh_token: "new-login" },
		});
		await new LaneDispatcher(options, dir, deps).tick();
		expect(reads).toBeGreaterThan(0);
		expect(decisions).toBe(lostReply ? 2 : 1);
	},
);
