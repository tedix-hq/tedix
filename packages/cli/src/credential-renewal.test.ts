import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readWorkspaceCredentials,
	writeWorkspaceCredentials,
} from "./credential-store";

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
});
