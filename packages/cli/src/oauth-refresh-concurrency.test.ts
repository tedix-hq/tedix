import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCredentialLock, credentialLockPath } from "./credential-lock";
import {
	readWorkspaceCredentials,
	writeWorkspaceCredentials,
	type WorkspaceCredential,
} from "./credential-store";

const providerModule = new URL("./oauth-provider.ts", import.meta.url).pathname;
const storeModule = new URL("./credential-store.ts", import.meta.url).pathname;

for (const invalidated of [false, true]) {
	test(`eight processes share one refresh (${invalidated ? "invalidated" : "rotated"})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-refresh-processes-"));
		let requests = 0;
		let ready = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname === "/ready") {
					if (++ready === 8) release();
					await barrier;
					return new Response("ready");
				}
				requests++;
				const body = await request.formData();
				expect(body.get("refresh_token")).toBe("original-refresh");
				await Bun.sleep(50);
				return invalidated
					? Response.json(
							{
								error: "invalid_grant",
								error_description: "E064006: family ID invalidated",
							},
							{ status: 400 },
						)
					: Response.json({
							access_token: "cached-access",
							refresh_token: "rotated-refresh",
							token_type: "Bearer",
							expires_in: 600,
						});
			},
		});
		const credential: WorkspaceCredential = {
			loginId: "fixture-user",
			org: "org_fixture",
			mcpUrl: "https://fixture.example/mcp",
			accessTokenExpiresAtSeconds: 1,
			oauthTokens: {
				access_token: "expired",
				refresh_token: "original-refresh",
				token_type: "Bearer",
			},
			oauthClientInformation: { client_id: "fixture-client" },
			oauthDiscoveryState: {
				authorizationServerUrl: server.url.origin,
				authorizationServerMetadata: {
					issuer: server.url.origin,
					authorization_endpoint: `${server.url.origin}/authorize`,
					token_endpoint: `${server.url.origin}/token`,
					response_types_supported: ["code"],
				},
			},
		};
		writeWorkspaceCredentials("fixture", credential, { configDir: dir });
		const children = Array.from({ length: 8 }, (_, lane) =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					`
				import { WorkspaceOAuthProvider, refreshStoredSession, renewStoredSession } from ${JSON.stringify(providerModule)};
				import { readWorkspaceCredentials } from ${JSON.stringify(storeModule)};
				const credential = readWorkspaceCredentials("fixture");
				const provider = new WorkspaceOAuthProvider({
					mcpUrl: credential.mcpUrl, credential,
					${lane % 2 ? 'workspace: "fixture",' : ""}
				});
				await fetch(${JSON.stringify(`${server.url.origin}/ready`)});
				const outcome = await refreshStoredSession(provider, {
					${lane % 2 ? "" : 'workspace: "fixture",'}
					isDarkWake: () => false,
				});
				const cached = await renewStoredSession(provider, { workspace: "fixture", command: ["/nonexistent-renewer", []] });
				console.log(JSON.stringify({ outcome, cached, token: provider.tokens()?.access_token }));
			`,
				],
				{
					env: { ...process.env, TEDIX_CONFIG_DIR: dir },
					stdout: "pipe",
					stderr: "pipe",
				},
			),
		);
		try {
			const results = await Promise.all(
				children.map(async (child) => ({
					code: await child.exited,
					stdout: await new Response(child.stdout).text(),
					stderr: await new Response(child.stderr).text(),
				})),
			);
			expect(requests).toBe(1);
			for (const result of results) expect(result.code).toBe(0);
			const outcomes = results.map((result) => JSON.parse(result.stdout));
			if (invalidated) {
				expect(
					outcomes.every(
						(result) =>
							result.outcome === "invalidated" &&
							result.cached === "invalidated",
					),
				).toBe(true);
				expect(
					results
						.map((result) => result.stderr)
						.join("")
						.match(/Run `tedix login`/g),
				).toHaveLength(1);
				expect(
					readWorkspaceCredentials("fixture", { configDir: dir })
						?.oauthRefreshInvalidated,
				).toBe(true);
			} else {
				expect(
					outcomes.filter((result) => result.outcome === "refreshed"),
				).toHaveLength(1);
				expect(
					outcomes.filter((result) => result.outcome === "not-needed"),
				).toHaveLength(7);
				expect(
					outcomes.every(
						(result) =>
							result.token === "cached-access" &&
							result.cached === "not-needed",
					),
				).toBe(true);
				expect(
					readWorkspaceCredentials("fixture", { configDir: dir })?.oauthTokens
						?.refresh_token,
				).toBe("rotated-refresh");
				expect(
					readWorkspaceCredentials("fixture", { configDir: dir })
						?.oauthRefreshPending,
				).toBeUndefined();
				expect(
					readWorkspaceCredentials("fixture", { configDir: dir })?.org,
				).toBe("org_fixture");
			}
		} finally {
			for (const child of children) child.kill();
			await Promise.all(children.map((child) => child.exited));
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);
}

test("recovers an abandoned stale lock within the wait timeout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tedix-stale-refresh-"));
	const path = credentialLockPath("fixture", dir);
	mkdirSync(path, { recursive: true });
	// Obtain a PID known to have exited, rather than guessing an unused PID.
	const owner = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore" });
	await owner.exited;
	writeFileSync(
		join(path, `${owner.pid}-abandoned.json`),
		JSON.stringify({ pid: owner.pid, ticket: 1 }),
	);
	try {
		const lock = await acquireCredentialLock("fixture", {
			configDir: dir,
			waitMs: 100,
			pollMs: 5,
		});
		expect(lock).not.toBeNull();
		lock?.release();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
