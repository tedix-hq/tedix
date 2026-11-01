import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readWorkspaceCredentials,
	writeWorkspaceCredentials,
} from "./credential-store";
import {
	RENEWAL_HANDOFF_ENV,
	renewStoredSession,
	refreshStoredSession,
	WorkspaceOAuthProvider,
} from "./oauth-provider";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
const WORKSPACE = "acme";

const jwt = (claims: object) =>
	`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/**
 * An authorization server that rotates refresh tokens and, like Descope,
 * invalidates the whole family when a superseded token is presented. The reply
 * is held after the rotation commits: the window in which a killed client used
 * to lose the only valid token.
 */
function rotatingServer(replyDelayMs: number) {
	const state = { current: "refresh-0", rotations: 0, invalidated: false };
	let firstRequest: () => void;
	const requested = new Promise<void>((resolve) => {
		firstRequest = resolve;
	});
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/token")
				return new Response("not found", { status: 404 });
			const presented = new URLSearchParams(await request.text()).get(
				"refresh_token",
			);
			if (state.invalidated || presented !== state.current) {
				state.invalidated = true;
				return Response.json(
					{
						error: "invalid_grant",
						error_description: "E064006 JWT family ID invalidated",
					},
					{ status: 400 },
				);
			}
			state.rotations += 1;
			state.current = `refresh-${state.rotations}`;
			firstRequest();
			await Bun.sleep(replyDelayMs);
			return Response.json({
				access_token: jwt({
					sub: "user-1",
					exp: Math.floor(Date.now() / 1000) + 600,
				}),
				token_type: "Bearer",
				expires_in: 600,
				refresh_token: state.current,
			});
		},
	});
	return { server, state, requested };
}

function storeExpiredLogin(base: string, refreshToken: string) {
	writeWorkspaceCredentials(WORKSPACE, {
		loginId: "user-1",
		mcpUrl: `${base}/mcp`,
		accessTokenExpiresAtSeconds: Math.floor(Date.now() / 1000) - 1,
		oauthTokens: {
			access_token: jwt({ sub: "user-1", exp: 1 }),
			token_type: "Bearer",
			refresh_token: refreshToken,
		},
		oauthClientInformation: { client_id: "client-1" },
		oauthDiscoveryState: {
			authorizationServerUrl: base,
			authorizationServerMetadata: {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				response_types_supported: ["code"],
			},
		},
	});
}

/** An ordinary stored-login command; it renews before calling the gateway. */
function startCommand() {
	const child = spawn(
		process.execPath,
		[CLI, "--workspace", WORKSPACE, "work", "list"],
		{ detached: true, stdio: "ignore" },
	);
	const exited = new Promise<void>((resolve) => child.once("close", resolve));
	return { child, exited };
}

/** Claude Code's timed-out hook kill: every descendant by parent PID. */
function killDescendants(root: number) {
	const children = new Map<number, number[]>();
	const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="]);
	for (const line of ps.stdout.toString().split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
	}
	const queue = [root];
	for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
		queue.push(...(children.get(pid) ?? []));
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

async function until(check: () => boolean, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) return false;
		await Bun.sleep(50);
	}
	return true;
}

describe("stored login renewal across processes", () => {
	test("six commands killed mid-renewal still leave the login usable", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-renewal-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = configDir;
		const { server, state, requested } = rotatingServer(1_000);
		const base = `http://127.0.0.1:${server.port}`;
		const storedRefresh = () =>
			readWorkspaceCredentials(WORKSPACE)?.oauthTokens?.refresh_token;
		try {
			storeExpiredLogin(base, state.current);

			// Six commands need a renewal at once. Kill every one of them, the way a
			// hook deadline kills its process group, after the server rotated the
			// token but before its reply arrives.
			const first = Array.from({ length: 6 }, startCommand);
			await requested;
			for (const { child } of first) {
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {}
			}
			await Promise.all(first.map(({ exited }) => exited));
			expect(await until(() => storedRefresh() === state.current, 15_000)).toBe(
				true,
			);
			expect(state.rotations).toBe(1);

			// The next renewal presents the token the server issued, not the one
			// it superseded, so the family survives.
			storeExpiredLogin(base, state.current);
			const second = Array.from({ length: 6 }, startCommand);
			await Promise.all(second.map(({ exited }) => exited));
			expect(state.invalidated).toBe(false);
			expect(state.rotations).toBe(2);
			expect(storedRefresh()).toBe(state.current);
		} finally {
			server.stop(true);
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	}, 60_000);

	test("a command whose whole process tree is killed still saves the rotation", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-renewal-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = configDir;
		const { server, state, requested } = rotatingServer(1_000);
		const base = `http://127.0.0.1:${server.port}`;
		try {
			storeExpiredLogin(base, state.current);
			// Claude Code kills a timed-out hook's descendants by parent PID, which
			// reaches a renewer in its own process group too.
			const command = startCommand();
			await requested;
			killDescendants(command.child.pid!);
			await command.exited;
			expect(
				await until(
					() =>
						readWorkspaceCredentials(WORKSPACE)?.oauthTokens?.refresh_token ===
						state.current,
					15_000,
				),
			).toBe(true);
			expect(state.rotations).toBe(1);
		} finally {
			server.stop(true);
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	}, 30_000);

	test("the renewer is started without a shell, so metacharacters stay inert", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-renewal-$(touch x);`x`'\""));
		const canary = join(dir, "injected");
		const record = join(dir, "record.json");
		const renewer = join(dir, "renewer;$(touch x).ts");
		writeFileSync(
			renewer,
			`require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ ppid: process.ppid, argv: process.argv.slice(2), handoff: process.env.${RENEWAL_HANDOFF_ENV} ?? null }));
process.stdout.write("unavailable\\n");`,
		);
		const workspace = `acme; touch ${canary} $(touch ${canary}) \`touch ${canary}\``;
		writeWorkspaceCredentials(
			workspace,
			{
				loginId: "fixture-user",
				mcpUrl: "https://fixture.example/mcp",
				accessTokenExpiresAtSeconds: 1,
				oauthTokens: {
					access_token: "expired",
					refresh_token: "refresh",
					token_type: "Bearer",
				},
			},
			{ configDir: dir },
		);
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = dir;
		try {
			const provider = new WorkspaceOAuthProvider({
				workspace,
				mcpUrl: "https://fixture.example/mcp",
			});
			const outcome = await renewStoredSession(provider, {
				workspace,
				command: [process.execPath, [renewer]],
			});
			expect(outcome).toBe("unavailable");
			const seen = JSON.parse(readFileSync(record, "utf8"));
			expect(seen.argv).toEqual(["auth", "renew", "--workspace", workspace]);
			// Started directly: a shell in between would be the renewer's parent.
			expect(seen.ppid).toBe(process.pid);
			expect(seen.handoff).toBe(process.platform === "win32" ? null : "1");
			expect(existsSync(canary)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

for (const [status, body, oauthError, terminal] of [
	[503, "<html>upstream unavailable</html>", undefined, false],
	[500, '{"error":"invalid_grant"}', "invalid_grant", false],
	[
		429,
		'{"error":"temporarily_unavailable"}',
		"temporarily_unavailable",
		false,
	],
	[429, "rate limited", undefined, false],
	[400, "<html>bad gateway</html>", undefined, false],
	[200, "{", undefined, false],
	[200, '{"message":"upstream unavailable"}', undefined, false],
	[400, '{"message":"upstream unavailable"}', undefined, false],
	[400, '{"error":"invalid_grant"}', "invalid_grant", true],
	[403, '{"error":"access_denied"}', "access_denied", true],
] as const) {
	test(`renewal classifies HTTP ${status}: ${body}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-renewal-response-"));
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = dir;
		try {
			const base = "https://auth.fixture.example";
			storeExpiredLogin(base, "refresh-0");
			const provider = new WorkspaceOAuthProvider({
				workspace: WORKSPACE,
				mcpUrl: `${base}/mcp`,
			});
			let posts = 0;
			const fetchFn = async (_input: unknown, init?: RequestInit) => {
				posts++;
				expect((init?.body as URLSearchParams).get("refresh_token")).toBe(
					"refresh-0",
				);
				if (posts === 1) return new Response(body, { status });
				return Response.json({
					access_token: jwt({
						sub: "user-1",
						exp: Math.floor(Date.now() / 1000) + 600,
					}),
					token_type: "Bearer",
					refresh_token: "refresh-1",
					expires_in: 600,
				});
			};
			expect(
				await refreshStoredSession(provider, {
					fetchFn,
					isDarkWake: () => false,
				}),
			).toBe(terminal ? "invalidated" : "failed");
			const stored = readWorkspaceCredentials(WORKSPACE)!;
			expect(stored.oauthRefreshPending).toBeUndefined();
			expect(stored.oauthRefreshInvalidated).toBe(terminal ? true : undefined);
			const entry = JSON.parse(
				readFileSync(join(dir, "renewals.log"), "utf8").trim(),
			);
			expect(entry.httpStatus).toBe(status);
			expect(entry.oauthError).toBe(oauthError);
			expect(entry.failure).toBe(
				terminal ? "oauth-error" : "retryable-response",
			);
			if (!oauthError) expect(entry.responsePreview).toBe(body);
			expect(
				await refreshStoredSession(provider, {
					fetchFn,
					isDarkWake: () => false,
				}),
			).toBe(terminal ? "invalidated" : "refreshed");
			expect(posts).toBe(terminal ? 1 : 2);
			if (!terminal)
				expect(
					readWorkspaceCredentials(WORKSPACE)?.oauthTokens?.refresh_token,
				).toBe("refresh-1");
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("renewal journal redacts before truncating unexpected replies to 120 bytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tedix-renewal-redaction-"));
	const previous = process.env.TEDIX_CONFIG_DIR;
	process.env.TEDIX_CONFIG_DIR = dir;
	try {
		const base = "https://auth.fixture.example";
		storeExpiredLogin(base, "refresh-0");
		const stored = readWorkspaceCredentials(WORKSPACE)!;
		const provider = new WorkspaceOAuthProvider({
			workspace: WORKSPACE,
			mcpUrl: `${base}/mcp`,
		});
		const body = `refresh-0 ${stored.oauthTokens!.access_token} Bearer secret-value ${"é".repeat(150)}`;
		expect(
			await refreshStoredSession(provider, {
				isDarkWake: () => false,
				fetchFn: async () => new Response(body, { status: 502 }),
			}),
		).toBe("failed");
		const journal = readFileSync(join(dir, "renewals.log"), "utf8");
		expect(journal).not.toContain("refresh-0");
		expect(journal).not.toContain(stored.oauthTokens!.access_token);
		expect(journal).not.toContain("secret-value");
		expect(
			Buffer.byteLength(JSON.parse(journal).responsePreview),
		).toBeLessThanOrEqual(120);
	} finally {
		if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
		else process.env.TEDIX_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a new login saved during a transient response is never overwritten", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tedix-renewal-replacement-"));
	const previous = process.env.TEDIX_CONFIG_DIR;
	process.env.TEDIX_CONFIG_DIR = dir;
	try {
		const base = "https://auth.fixture.example";
		storeExpiredLogin(base, "refresh-0");
		const provider = new WorkspaceOAuthProvider({
			workspace: WORKSPACE,
			mcpUrl: `${base}/mcp`,
		});
		expect(
			await refreshStoredSession(provider, {
				isDarkWake: () => false,
				fetchFn: async () => {
					storeExpiredLogin(base, "new-human-grant");
					return new Response("unavailable", { status: 503 });
				},
			}),
		).toBe("failed");
		expect(
			readWorkspaceCredentials(WORKSPACE)?.oauthTokens?.refresh_token,
		).toBe("new-human-grant");
		expect(
			readWorkspaceCredentials(WORKSPACE)?.oauthRefreshPending,
		).toBeUndefined();
	} finally {
		if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
		else process.env.TEDIX_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
