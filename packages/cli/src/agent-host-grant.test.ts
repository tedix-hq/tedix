import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readAgentHostProfile,
	revokeAgentHostGrants,
} from "./agent-host-grant";
import { TEDIX_CONNECT_MCP_URL } from "./oauth-provider";

const token = (revision: string, aud = TEDIX_CONNECT_MCP_URL) =>
	`e30.${Buffer.from(JSON.stringify({ aud, token_type: "access_token", dci: "shared-consent", tedixConsentRevision: revision })).toString("base64url")}.signature`;

describe("checking an agent's Tedix account", () => {
	it.each(["devin", "opencode"] as const)(
		"reads the profile with %s's credential without changing it or answering consent",
		async (host) => {
			const stored = {
				tokens: { accessToken: token(host), refreshToken: "private-refresh" },
			};
			let writes = 0;
			const methods: string[] = [];
			const profile = { id: "user_other", email: "other@example.com" };
			const result = await readAgentHostProfile(host, {
				stores: [{ read: () => stored, write: () => writes++ }],
				fetcher: async (url, init) => {
					expect(String(url)).toBe(TEDIX_CONNECT_MCP_URL);
					expect(new Headers(init?.headers).get("Authorization")).toBe(
						`Bearer ${stored.tokens.accessToken}`,
					);
					expect(String(init?.body)).not.toContain("private-refresh");
					const request = JSON.parse(String(init?.body));
					methods.push(request.method);
					if (request.method === "tools/call")
						expect(request.params).toMatchObject({
							name: "get_profile",
							arguments: {},
						});
					return Response.json({
						jsonrpc: "2.0",
						id: request.id,
						result:
							request.method === "server/discover"
								? { supportedVersions: ["2026-07-28"] }
								: { content: [], structuredContent: profile },
					});
				},
			});
			expect(result).toMatchObject({ structuredContent: profile });
			expect(methods).toEqual(["server/discover", "tools/call"]);
			expect(writes).toBe(0);
		},
	);

	it("refuses ambiguous or changed credentials rather than reporting the wrong account", async () => {
		const credential = (name: string) => ({
			accessToken: token(name),
			refreshToken: "private-refresh",
		});
		let stored = credential("before");
		const store = { read: () => stored, write: () => {} };
		await expect(
			readAgentHostProfile("devin", {
				stores: [store, { read: () => credential("other"), write: () => {} }],
				fetcher: async () => {
					throw new Error("Must not call with an ambiguous sign-in");
				},
			}),
		).rejects.toThrow("Could not identify one Tedix sign-in");
		await expect(
			readAgentHostProfile("opencode", {
				stores: [store],
				fetcher: async (_url, init) => {
					const request = JSON.parse(String(init?.body));
					if (request.method === "tools/call") stored = credential("after");
					return Response.json({
						jsonrpc: "2.0",
						id: request.id,
						result:
							request.method === "server/discover"
								? { supportedVersions: ["2026-07-28"] }
								: {
										structuredContent: { id: "old", email: "old@example.com" },
									},
					});
				},
			}),
		).rejects.toThrow("sign-in in opencode changed");
	});
});

describe("removing one agent's stored Tedix sign-in", () => {
	it("selects OpenCode's named connection and active credential while preserving other sign-ins to the same server", async () => {
		const root = mkdtempSync(join(tmpdir(), "tedix-remove-opencode-"));
		const directory = join(root, "opencode");
		mkdirSync(directory);
		const path = join(directory, "mcp-auth.json");
		const credential = (name: string) => ({
			tokens: { accessToken: token(name), refreshToken: `refresh-${name}` },
		});
		writeFileSync(
			path,
			JSON.stringify({
				tedix: credential("target"),
				another: credential("another"),
			}),
		);
		const db = new Database(join(directory, "opencode.db"));
		try {
			db.exec(
				"CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER)",
			);
			const integration = `mcp_${createHash("sha1").update(`tedix\0${TEDIX_CONNECT_MCP_URL}`).digest("hex").slice(0, 16)}`;
			const insert = db.query("INSERT INTO credential VALUES (?, ?, ?, ?)");
			insert.run(
				"target",
				integration,
				JSON.stringify({
					type: "oauth",
					access: token("target-db"),
					refresh: "refresh-db",
				}),
				1,
			);
			insert.run(
				"inactive",
				integration,
				JSON.stringify(credential("inactive")),
				0,
			);
			insert.run(
				"another",
				"another-integration",
				JSON.stringify(credential("another")),
				1,
			);
			const readProfile = (switchAccount = false) =>
				readAgentHostProfile("opencode", {
					env: { XDG_DATA_HOME: root },
					fetcher: async (_url, init) => {
						expect(new Headers(init?.headers).get("Authorization")).toBe(
							`Bearer ${token("target-db")}`,
						);
						const request = JSON.parse(String(init?.body));
						if (switchAccount && request.method === "tools/call")
							db.query(
								"UPDATE credential SET active = 0 WHERE id = 'target'",
							).run();
						return Response.json({
							jsonrpc: "2.0",
							id: request.id,
							result:
								request.method === "server/discover"
									? { supportedVersions: ["2026-07-28"] }
									: {
											structuredContent: {
												id: "current",
												email: "current@example.com",
											},
										},
						});
					},
				});
			expect(await readProfile()).toMatchObject({
				structuredContent: { email: "current@example.com" },
			});
			await expect(readProfile(true)).rejects.toThrow(
				"sign-in in opencode changed",
			);
			db.query("UPDATE credential SET active = 1 WHERE id = 'target'").run();
			expect(
				await revokeAgentHostGrants("opencode", {
					env: { XDG_DATA_HOME: root },
					fetcher: async () => Response.json({ revoked: true }),
				}),
			).toBe(2);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				another: credential("another"),
			});
			expect(db.query("SELECT id FROM credential ORDER BY id").all()).toEqual([
				{ id: "another" },
				{ id: "inactive" },
			]);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ access_token: token("install"), refresh_token: "refresh-install" },
		{
			server_name: "tedix",
			token_response: {
				access_token: token("install"),
				refresh_token: "refresh-install",
			},
		},
		{ accessToken: token("install"), refreshToken: "refresh-install" },
		{
			tokens: {
				accessToken: token("install"),
				refreshToken: "refresh-install",
			},
			clientInfo: { clientId: "shared-client" },
		},
	])(
		"revokes the selected native credential and preserves other accounts",
		async (credential) => {
			const other = {
				accessToken: token("other", "https://other.example/mcp"),
				refreshToken: "refresh-other",
			};
			let stored: unknown = {
				ownAccount: { accessToken: "agent-account" },
				mcpOAuth: { tedix: credential, other },
			};
			const calls: Record<string, unknown>[] = [];
			const count = await revokeAgentHostGrants("claude", {
				stores: [
					{
						read: () => stored,
						write: (value) => {
							stored = value;
						},
					},
				],
				fetcher: (async (url, init) => {
					expect(url).toBe(`${TEDIX_CONNECT_MCP_URL}/revoke`);
					calls.push(JSON.parse(String(init?.body)));
					expect(stored).toMatchObject({ mcpOAuth: { tedix: credential } });
					return Response.json({ revoked: true });
				}) as typeof fetch,
			});
			expect(count).toBe(1);
			expect(calls).toEqual([
				{ accessToken: token("install"), refreshToken: "refresh-install" },
			]);
			expect(stored).toEqual({
				ownAccount: { accessToken: "agent-account" },
				mcpOAuth: { other },
			});
		},
	);

	it("keeps local credentials when the server fails or a concurrent renewal changes the token", async () => {
		for (const renew of [false, true]) {
			let stored = { access_token: token("install"), refresh_token: "before" };
			let writes = 0;
			await expect(
				revokeAgentHostGrants("devin", {
					stores: [
						{
							read: () => stored,
							write: () => {
								writes++;
							},
						},
					],
					fetcher: async () => {
						if (renew) stored = { ...stored, refresh_token: "renewed" };
						return renew
							? Response.json({ revoked: true })
							: new Response(null, { status: 503 });
					},
				}),
			).rejects.toThrow("connection was kept");
			expect(writes).toBe(0);
		}
	});
});
