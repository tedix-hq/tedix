import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceOAuthProvider } from "./oauth-provider";
import {
	readWorkspaceCredentials,
	writeWorkspaceCredentials,
	type WorkspaceCredential,
} from "./credential-store";

const providerModule = new URL("./oauth-provider.ts", import.meta.url).pathname;
const storeModule = new URL("./credential-store.ts", import.meta.url).pathname;

test("a stale metadata save cannot restore a superseded refresh token", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tedix-stale-provider-"));
	const previous = process.env.TEDIX_CONFIG_DIR;
	process.env.TEDIX_CONFIG_DIR = dir;
	try {
		const credential: WorkspaceCredential = {
			loginId: "fixture-user",
			oauthTokens: {
				access_token: "old-access",
				refresh_token: "old-refresh",
				token_type: "Bearer",
			},
		};
		writeWorkspaceCredentials("fixture", credential);
		const provider = new WorkspaceOAuthProvider({
			mcpUrl: "https://fixture.example/mcp",
			workspace: "fixture",
			credential,
			persist: true,
		});
		const fresh = {
			...credential,
			oauthTokens: {
				...credential.oauthTokens!,
				access_token: "new-access",
				refresh_token: "new-refresh",
			},
		};
		writeWorkspaceCredentials("fixture", fresh);
		await expect(
			provider.saveClientInformation({ client_id: "fixture-client" }),
		).rejects.toThrow("Credentials changed");
		expect(readWorkspaceCredentials("fixture")?.oauthTokens).toEqual(
			fresh.oauthTokens,
		);
	} finally {
		if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
		else process.env.TEDIX_CONFIG_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const failure of ["timeout", "body", "killed", "save"] as const) {
	test(`a ${failure} after rotation cannot replay the consumed token`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-uncertain-refresh-"));
		let requests = 0;
		let invalidated = false;
		let markedBeforeSend = false;
		let requested!: () => void;
		const requestReceived = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const server = Bun.serve({
			port: 0,
			async fetch() {
				requests++;
				markedBeforeSend =
					readWorkspaceCredentials("fixture", { configDir: dir })
						?.oauthRefreshPending === true;
				if (requests > 1) {
					invalidated = true;
					return Response.json(
						{
							error: "invalid_grant",
							error_description: "E064006 family ID invalidated",
						},
						{ status: 400 },
					);
				}
				requested();
				if (failure === "timeout" || failure === "killed") await Bun.sleep(300);
				if (failure === "body")
					return new Response("{", {
						headers: { "content-type": "application/json" },
					});
				return Response.json({
					access_token: "new-access",
					refresh_token: "new-refresh",
					token_type: "Bearer",
					expires_in: 600,
				});
			},
		});
		const credential: WorkspaceCredential = {
			loginId: "fixture-user",
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
		const command = (first = false) =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					`
			import { WorkspaceOAuthProvider, refreshStoredSession } from ${JSON.stringify(providerModule)};
			import { readWorkspaceCredentials } from ${JSON.stringify(storeModule)};
			const credential = readWorkspaceCredentials("fixture");
			const provider = new WorkspaceOAuthProvider({ mcpUrl: credential.mcpUrl, workspace: "fixture", credential });
			${first && failure === "save" ? 'provider.saveRenewedTokens = async () => { throw new Error("disk unavailable"); };' : ""}
			const result = await refreshStoredSession(provider, { isDarkWake: () => false, timeoutMs: ${first && failure === "timeout" ? 50 : 2000} });
			console.log(result);
		`,
				],
				{
					env: { ...process.env, TEDIX_CONFIG_DIR: dir },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
		const first = command(true);
		const children = [first];
		try {
			await requestReceived;
			if (failure === "killed") first.kill("SIGKILL");
			await first.exited;
			children.push(...Array.from({ length: 8 }, () => command()));
			const results = await Promise.all(
				children.slice(1).map(async (child) => {
					expect(await child.exited).toBe(0);
					return (await new Response(child.stdout).text()).trim();
				}),
			);
			expect(markedBeforeSend).toBe(true);
			expect(requests).toBe(1);
			expect(invalidated).toBe(false);
			expect(results).toEqual(Array(8).fill("uncertain"));
			expect(
				readWorkspaceCredentials("fixture", { configDir: dir })
					?.oauthRefreshPending,
			).toBe(true);

			// A metadata write from a stale provider must not erase the fence.
			writeWorkspaceCredentials("fixture", credential, { configDir: dir });
			expect(
				readWorkspaceCredentials("fixture", { configDir: dir })
					?.oauthRefreshPending,
			).toBe(true);
			// A new human grant has a different token and replaces the uncertain one.
			writeWorkspaceCredentials(
				"fixture",
				{
					...credential,
					oauthTokens: {
						...credential.oauthTokens!,
						refresh_token: "fresh-login",
					},
				},
				{ configDir: dir },
			);
			expect(
				readWorkspaceCredentials("fixture", { configDir: dir })
					?.oauthRefreshPending,
			).toBeUndefined();
		} finally {
			for (const child of children) {
				child.kill();
				await child.exited;
			}
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
}
