import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_SCOPES } from "@tedix/mcp-shared/auth/scopes";
import {
	defaultLocalPrincipal,
	externalAgentStatus,
	finishExternalAgentSession,
	renameExternalAgentPrincipal,
	renameNotice,
	resolveExternalAgentAuth,
	startExternalAgentSession,
} from "./external-agent";
import { writeExternalAgentProfile } from "./external-agent-store";
import type { WorkAttemptStore } from "./work-attempt-store";

const ORG = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const dirs: string[] = [];
const savedEnv = {
	config: process.env.TEDIX_CONFIG_DIR,
	session: process.env.TEDIX_AGENT_SESSION,
	organization: process.env.TEDIX_ORGANIZATION,
};

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	if (savedEnv.config === undefined) delete process.env.TEDIX_CONFIG_DIR;
	else process.env.TEDIX_CONFIG_DIR = savedEnv.config;
	if (savedEnv.session === undefined) delete process.env.TEDIX_AGENT_SESSION;
	else process.env.TEDIX_AGENT_SESSION = savedEnv.session;
	if (savedEnv.organization === undefined)
		delete process.env.TEDIX_ORGANIZATION;
	else process.env.TEDIX_ORGANIZATION = savedEnv.organization;
});

function exchangeResponse(): Response {
	return Response.json(
		{
			session: {
				id: SESSION,
				organizationId: ORG,
				principalId: PRINCIPAL,
				externalSessionKey: "codex:session-1",
				harness: "codex",
				harnessVersion: "1.2.3",
				modelProvider: "openai",
				modelId: "gpt-5.6",
				modelVersion: "2026-07-22",
				identitySource: "explicit",
				status: "active",
				creditEligible: true,
				startedAt: "2026-07-22T00:00:00.000Z",
				lastSeenAt: "2026-07-22T00:00:00.000Z",
				endedAt: null,
				metadata: {},
			},
			credential: {
				accessToken: "short-lived-mcp-token",
				clientRecordId: "client-record-id",
				expiresIn: 300,
				mcpServerUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			},
		},
		{ status: 201 },
	);
}

describe("external-agent CLI session", () => {
	test("binding mismatch gives safe recovery without retrying or changing the local session", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "codex:session-1";
		writeExternalAgentProfile("tedix", {
			organizationId: ORG,
			principalId: PRINCIPAL,
			key: "codex-ada",
			displayName: "Ada Codex",
			apiKeyId: "22222222-2222-4222-8222-222222222222",
			rawApiKey: "sk_external_secret",
			scopes: ["platform:admin"],
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			createdAt: "2026-07-22T00:00:00.000Z",
			sessions: {
				"codex:session-1": {
					id: SESSION,
					externalSessionKey: "codex:session-1",
					harness: "codex",
					harnessVersion: "1.2.3",
					modelProvider: "openai",
					modelId: "gpt-5.6",
					modelVersion: "2026-07-22",
					startedAt: "2026-07-22T00:00:00.000Z",
				},
			},
		});
		const before = externalAgentStatus("tedix");
		let calls = 0;
		await expect(
			resolveExternalAgentAuth({
				workspace: "tedix",
				selector: "codex-ada",
				fetch: async () => {
					calls += 1;
					return Response.json(
						{
							code: "credential_binding_mismatch",
							error: "must-not-leak sk_private",
						},
						{ status: 403 },
					);
				},
			}),
		).rejects.toThrow(
			"Stored external-agent credential does not match the registered principal. Run `tedix agent status` and have an owner inspect the principal credential binding before retrying. The local session is unchanged.",
		);
		expect(calls).toBe(1);
		expect(externalAgentStatus("tedix")).toEqual(before);
	});

	test("evicts an ended local session and prints an exact fresh-session recovery", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "codex:session-1";
		writeExternalAgentProfile("tedix", {
			organizationId: ORG,
			principalId: PRINCIPAL,
			key: "codex-ada",
			displayName: "Ada Codex",
			apiKeyId: "22222222-2222-4222-8222-222222222222",
			rawApiKey: "sk_external_secret",
			scopes: ["platform:admin"],
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			createdAt: "2026-07-22T00:00:00.000Z",
			sessions: {
				"codex:session-1": {
					id: SESSION,
					externalSessionKey: "codex:session-1",
					harness: "codex",
					harnessVersion: "1.2.3",
					modelProvider: "openai",
					modelId: "gpt-5.6",
					modelVersion: "2026-07-22",
					startedAt: "2026-07-22T00:00:00.000Z",
				},
			},
		});

		await expect(
			resolveExternalAgentAuth({
				workspace: "tedix",
				selector: "codex-ada",
				fetch: async () =>
					Response.json(
						{
							error: "Session exchange rejected",
							code: "session_ended",
						},
						{ status: 409 },
					),
			}),
		).rejects.toThrow(
			'External Agent-Session "codex:session-1" has ended and cannot be reopened.\nThe stale local session was removed.\nStart a fresh immutable session before retrying:\n  export TEDIX_AGENT_SESSION="codex:$(uuidgen',
		);
		expect(externalAgentStatus("tedix")).toMatchObject({
			currentSession: null,
			sessionCount: 0,
		});
		await expect(
			startExternalAgentSession({
				workspace: "tedix",
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				harness: "codex",
				harnessVersion: "1.2.3",
				modelProvider: "openai",
				modelId: "gpt-5.6",
				modelVersion: "2026-07-22",
				fetch: async () =>
					Response.json(
						{
							error: "Session exchange rejected",
							code: "session_ended",
						},
						{ status: 409 },
					),
			}),
		).rejects.toThrow(
			'External Agent-Session "codex:session-1" has ended and cannot be reopened.\nStart a fresh immutable session before retrying:',
		);
	});

	test("retries one compensated server-side session exchange failure", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "codex:session-1";
		writeExternalAgentProfile("tedix", {
			organizationId: ORG,
			principalId: PRINCIPAL,
			key: "codex-ada",
			displayName: "Ada Codex",
			apiKeyId: "22222222-2222-4222-8222-222222222222",
			rawApiKey: "sk_external_secret",
			scopes: ["platform:admin"],
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			createdAt: "2026-07-22T00:00:00.000Z",
			sessions: {},
		});
		let attempts = 0;

		const started = await startExternalAgentSession({
			workspace: "tedix",
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "openai",
			modelId: "gpt-5.6",
			modelVersion: "2026-07-22",
			fetch: async () => {
				attempts += 1;
				return attempts === 1
					? Response.json({ error: "Session exchange failed" }, { status: 503 })
					: exchangeResponse();
			},
			createClient: () => ({
				runCode: async () => ({ result: { success: true } }),
				close: async () => {},
			}),
		});

		expect(attempts).toBe(2);
		expect(started.session.externalSessionKey).toBe("codex:session-1");
	});

	test.each(["headers", "body", "late server failure"])(
		"bounds stalled exchange %s without discarding the session or retrying late",
		async (stage) => {
			const configDir = mkdtempSync(join(tmpdir(), "tedix-external-deadline-"));
			dirs.push(configDir);
			process.env.TEDIX_CONFIG_DIR = configDir;
			process.env.TEDIX_AGENT_SESSION = "codex:session-1";
			writeExternalAgentProfile("tedix", {
				organizationId: ORG,
				principalId: PRINCIPAL,
				key: "codex-ada",
				displayName: "Ada Codex",
				apiKeyId: "key-1",
				rawApiKey: "secret",
				scopes: ["platform:admin"],
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				createdAt: "2026-07-22T00:00:00.000Z",
				sessions: {},
			});
			await startExternalAgentSession({
				workspace: "tedix",
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				harness: "codex",
				harnessVersion: "1.2.3",
				modelProvider: "openai",
				modelId: "gpt-5.6",
				modelVersion: "2026-07-22",
				fetch: async () => exchangeResponse(),
			});
			const before = externalAgentStatus("tedix");
			let calls = 0;
			let signal: AbortSignal | null | undefined;
			await expect(
				resolveExternalAgentAuth({
					workspace: "tedix",
					selector: "codex-ada",
					sessionExchangeTimeoutMs: 10,
					fetch: async (_url, init) => {
						calls += 1;
						signal = init?.signal;
						if (stage === "headers") return new Promise<Response>(() => {});
						if (stage === "body") return new Response(new ReadableStream());
						await new Promise((resolve) => setTimeout(resolve, 25));
						return Response.json({ error: "late" }, { status: 503 });
					},
				}),
			).rejects.toThrow("credential exchange timed out");
			expect(signal?.aborted).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(calls).toBe(1);
			expect(externalAgentStatus("tedix")).toEqual(before);
		},
	);

	test.each([
		["busy then success", 409, "credential_issuance_in_progress", 2, true],
		["immutable conflict", 409, "immutable_session_conflict", 1, false],
		["unknown conflict", 409, undefined, 1, false],
		["server failure", 503, undefined, 2, false],
		["network failure", 0, undefined, 1, false],
		["permission denial", 403, "credential_issuance_in_progress", 1, false],
	])(
		"exchange retry boundary: %s",
		async (scenario, status, code, expectedCalls, succeeds) => {
			const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
			dirs.push(configDir);
			process.env.TEDIX_CONFIG_DIR = configDir;
			process.env.TEDIX_AGENT_SESSION = "codex:session-1";
			writeExternalAgentProfile("tedix", {
				organizationId: ORG,
				principalId: PRINCIPAL,
				key: "codex-ada",
				displayName: "Ada Codex",
				apiKeyId: "22222222-2222-4222-8222-222222222222",
				rawApiKey: "sk_external_secret",
				scopes: ["platform:admin"],
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				createdAt: "2026-07-22T00:00:00.000Z",
				sessions: {},
			});
			const bodies: string[] = [];
			const result = startExternalAgentSession({
				workspace: "tedix",
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				harness: "codex",
				harnessVersion: "1.2.3",
				modelProvider: "openai",
				modelId: "gpt-5.6",
				modelVersion: "2026-07-22",
				fetch: async (_url, init) => {
					bodies.push(String(init?.body));
					if (status === 0) throw new Error(scenario);
					return succeeds && bodies.length === 2
						? exchangeResponse()
						: Response.json({ error: scenario, code }, { status });
				},
			});
			if (succeeds) expect((await result).session.id).toBe(SESSION);
			else await expect(result).rejects.toThrow(scenario);
			expect(bodies).toHaveLength(expectedCalls);
			expect(new Set(bodies).size).toBe(1);
		},
	);

	test("bootstraps through Code Mode, exchanges only an X-API-Key, and reuses the profile without owner OAuth", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "session-1";
		const code: string[] = [];
		const exchangeRequests: Array<{ body: string; headers: Headers }> = [];
		const createClient = ({
			headers,
		}: {
			headers: Record<string, string>;
		}) => ({
			runCode: async (source: string) => {
				code.push(source);
				if (source.includes("organizations.create_api_key")) {
					return {
						result: {
							rawKey: "sk_external_secret",
							apiKey: { id: "22222222-2222-4222-8222-222222222222" },
						},
					};
				}
				if (source.includes("external.create_external_agent_principal")) {
					return { result: { id: PRINCIPAL } };
				}
				expect(headers["X-API-Key"]).toBe("short-lived-mcp-token");
				return { result: { success: true } };
			},
			close: async () => {},
		});
		const fetcher = async (
			_input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const body = String(init?.body);
			const headers = new Headers(init?.headers);
			exchangeRequests.push({ body, headers });
			expect(headers.get("X-API-Key")).toBe("sk_external_secret");
			expect(body).not.toContain("sk_external_secret");
			return exchangeResponse();
		};

		const started = await startExternalAgentSession({
			workspace: "tedix",
			workspaceCredential: {
				loginId: "owner",

				oauthTokens: {
					token_type: "Bearer",
					access_token: "oauth",
					refresh_token: "refresh",
				},
				accessTokenExpiresAtSeconds: 1,
				org: "org_tedix",
			},
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			oauthBearer: "oauth",
			agentKey: "codex-ada",
			displayName: "Ada Codex",
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "openai",
			modelId: "gpt-5.6",
			modelVersion: "2026-07-22",
			fetch: fetcher,
			createClient,
			listWorkspaces: async () => [
				{
					org: ORG,
					slug: "tedix",
					name: "Tedix",
					gatewayUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
					descopeTenantId: "org_tedix",
				},
			],
		});
		expect(started.session.externalSessionKey).toBe("codex:session-1");
		expect(
			code.some((source) => source.includes("organizations.create_api_key")),
		).toBe(true);
		expect(
			code.some((source) =>
				source.includes("external.create_external_agent_principal"),
			),
		).toBe(true);

		await startExternalAgentSession({
			workspace: "tedix",
			mcpUrl: "https://unused.example/mcp",
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "openai",
			modelId: "gpt-5.6",
			modelVersion: "2026-07-22",
			fetch: fetcher,
			createClient,
		});
		expect(
			code.filter((source) => source.includes("create_api_key")),
		).toHaveLength(1);

		const auth = await resolveExternalAgentAuth({
			workspace: "tedix",
			selector: "codex-ada",
			fetch: fetcher,
			createClient,
		});
		expect(auth.headers).toEqual({ "X-API-Key": "short-lived-mcp-token" });
		const reused = await resolveExternalAgentAuth({
			workspace: "tedix",
			selector: "codex-ada",
			fetch: async () => {
				throw new Error("cache hit must not exchange again");
			},
		});
		expect(reused.headers).toEqual(auth.headers);
		expect(JSON.stringify(externalAgentStatus("tedix"))).not.toContain(
			"short-lived-mcp-token",
		);

		// Credentials persist for server-side reuse: the auth resolution exposes
		// no per-operation `cleanup` revoke, and the CLI never mints-then-revokes
		// a Descope MCP client during normal operation.
		expect(auth.cleanup).toBeUndefined();
		await auth.cleanup?.();
		expect(
			code.some((source) =>
				source.includes("external.revoke_external_agent_mcp_credential"),
			),
		).toBe(false);

		const rendered = JSON.stringify(externalAgentStatus("tedix"));
		expect(rendered).not.toContain("sk_external_secret");
		expect(
			readFileSync(join(configDir, "external-agents.json"), "utf8"),
		).toContain("sk_external_secret");

		await finishExternalAgentSession({
			workspace: "tedix",
			idempotencyKey: "diagnostic-session-v1",
			zeroWorkReason: "No board work was claimed.",
			fetch: fetcher,
			createClient,
		});
		// Session teardown revokes the reused client via end_external_agent_session;
		// the CLI never issues a standalone revoke_external_agent_mcp_credential.
		expect(
			code.some((source) =>
				source.includes("external.end_external_agent_session"),
			),
		).toBe(true);
		expect(
			code.some((source) =>
				source.includes("external.revoke_external_agent_mcp_credential"),
			),
		).toBe(false);
		expect(JSON.stringify(externalAgentStatus("tedix"))).not.toContain(
			"codex:session-1",
		);
		// Two explicit starts and one auth cache miss; reuse and teardown do not reissue.
		expect(exchangeRequests).toHaveLength(3);
	});

	test("retries issuance contention beyond the former fixed ceiling", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "codex:session-1";
		writeExternalAgentProfile("tedix", {
			organizationId: ORG,
			principalId: PRINCIPAL,
			key: "codex-ada",
			displayName: "Ada Codex",
			apiKeyId: "22222222-2222-4222-8222-222222222222",
			rawApiKey: "sk_external_secret",
			scopes: ["platform:admin"],
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			createdAt: "2026-07-22T00:00:00.000Z",
			sessions: {},
		});
		let attempts = 0;
		const started = await startExternalAgentSession({
			workspace: "tedix",
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "openai",
			modelId: "gpt-5.6",
			modelVersion: "2026-07-22",
			fetch: async () => {
				attempts += 1;
				return attempts < 5
					? Response.json(
							{
								error: "Credential issuance is busy; retry shortly",
								code: "credential_issuance_in_progress",
							},
							{ status: 409 },
						)
					: exchangeResponse();
			},
		});
		expect(started.session.id).toBe(SESSION);
		expect(attempts).toBe(5);
	});

	test("settles an unfinished attempt before ending a session", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "codex:session-1";
		const workItemId = "55555555-5555-4555-8555-555555555555";
		const attemptId = "66666666-6666-4666-8666-666666666666";
		writeExternalAgentProfile("tedix", {
			organizationId: ORG,
			principalId: PRINCIPAL,
			key: "codex-ada",
			displayName: "Ada Codex",
			apiKeyId: "22222222-2222-4222-8222-222222222222",
			rawApiKey: "sk_external_secret",
			scopes: ["platform:admin"],
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			createdAt: "2026-07-22T00:00:00.000Z",
			sessions: {
				"codex:session-1": {
					id: SESSION,
					externalSessionKey: "codex:session-1",
					harness: "codex",
					harnessVersion: "1.2.3",
					modelProvider: "openai",
					modelId: "gpt-5.6",
					modelVersion: "2026-07-22",
					startedAt: "2026-07-22T00:00:00.000Z",
				},
			},
		});
		const sources: string[] = [];
		const removed: string[] = [];
		const attemptStore: WorkAttemptStore = {
			get: () => attemptId,
			set: () => {},
			remove: (_key, expectedAttemptId) => {
				removed.push(expectedAttemptId);
				return true;
			},
		};

		await finishExternalAgentSession({
			workspace: "tedix",
			workItemId,
			idempotencyKey: "finished-session-v1",
			noHandoffReason: "All durable evidence is attached to the Work Item.",
			fetch: async () => exchangeResponse(),
			attemptStore,
			createClient: () => ({
				runCode: async (source: string) => {
					sources.push(source);
					return { result: { success: true } };
				},
				close: async () => {},
			}),
		});

		expect(
			sources.map((source) => source.match(/await ([a-z_.]+)\(/)?.[1]),
		).toEqual([
			"external.record_external_agent_knowledge_disposition",
			"work.settle_work_item_attempt",
			"external.end_external_agent_session",
		]);
		expect(sources[1]).toContain(`"id":"${workItemId}"`);
		expect(sources[1]).toContain(`"attemptId":"${attemptId}"`);
		expect(sources[1]).toContain('"outcome":"cancelled"');
		expect(removed).toEqual([attemptId]);
		expect(externalAgentStatus("tedix").currentSession).toBeNull();
	});

	test("revokes the freshly created API key when principal creation fails", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "session-1";
		const code: string[] = [];
		const createClient = () => ({
			runCode: async (source: string) => {
				code.push(source);
				if (source.includes("organizations.create_api_key")) {
					return {
						result: {
							rawKey: "sk_compensate",
							apiKey: { id: "22222222-2222-4222-8222-222222222222" },
						},
					};
				}
				if (source.includes("external.create_external_agent_principal")) {
					throw new Error("principal failed");
				}
				return { result: { success: true } };
			},
			close: async () => {},
		});
		await expect(
			startExternalAgentSession({
				workspace: "tedix",
				workspaceCredential: {
					loginId: "owner",

					oauthTokens: {
						token_type: "Bearer",
						access_token: "oauth",
						refresh_token: "refresh",
					},
					accessTokenExpiresAtSeconds: 1,
					org: "org_tedix",
				},
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				oauthBearer: "oauth",
				agentKey: "codex-ada",
				displayName: "Ada Codex",
				harness: "codex",
				harnessVersion: "1.2.3",
				modelProvider: "openai",
				modelId: "gpt-5.6",
				modelVersion: "2026-07-22",
				createClient,
				listWorkspaces: async () => [
					{
						org: ORG,
						slug: "tedix",
						name: "Tedix",
						gatewayUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
						descopeTenantId: "org_tedix",
					},
				],
			}),
		).rejects.toThrow("principal failed");
		expect(
			code.some((source) => source.includes("organizations.revoke_api_key")),
		).toBe(true);
	});

	function scopesBootstrapClient(code: string[]) {
		return () => ({
			runCode: async (source: string) => {
				code.push(source);
				if (source.includes("organizations.create_api_key")) {
					return {
						result: {
							rawKey: "sk_external_secret",
							apiKey: { id: "22222222-2222-4222-8222-222222222222" },
						},
					};
				}
				if (source.includes("external.create_external_agent_principal")) {
					return { result: { id: PRINCIPAL } };
				}
				return { result: { success: true } };
			},
			close: async () => {},
		});
	}

	function extractCreateApiKeyScopes(code: string[]): unknown {
		const source = code.find((s) => s.includes("organizations.create_api_key"));
		const json = source?.slice(
			source.indexOf("{"),
			source.lastIndexOf("}") + 1,
		);
		return json ? (JSON.parse(json) as { scopes?: unknown }).scopes : undefined;
	}

	const bootstrapBase = {
		workspace: "tedix",
		workspaceCredential: {
			loginId: "owner",

			oauthTokens: {
				token_type: "Bearer",
				access_token: "oauth",
				refresh_token: "refresh",
			},
			accessTokenExpiresAtSeconds: 1,
			org: "org_tedix",
		},
		mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		oauthBearer: "oauth",
		displayName: "Ada Codex",
		harness: "codex",
		harnessVersion: "1.2.3",
		modelProvider: "openai",
		modelId: "gpt-5.6",
		modelVersion: "2026-07-22",
		listWorkspaces: async () => [
			{
				org: ORG,
				slug: "tedix",
				name: "Tedix",
				gatewayUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				descopeTenantId: "org_tedix",
			},
		],
	} as const;

	test.each(["explicit", "terminal", "sole selection"])(
		"Connect bootstrap targets the runtime organization UUID through %s",
		async (mode) => {
			const configDir = mkdtempSync(join(tmpdir(), "tedix-external-connect-"));
			dirs.push(configDir);
			process.env.TEDIX_CONFIG_DIR = configDir;
			process.env.TEDIX_AGENT_SESSION = "session-1";
			process.env.TEDIX_ORGANIZATION = mode === "terminal" ? "tedix" : "";
			const code: string[] = [];
			const factory = scopesBootstrapClient(code);
			const ownerHeaders: Record<string, string>[] = [];
			const selected =
				mode === "sole selection" ? ["org_tedix"] : ["org_tedix", "org_wrong"];
			const oauthBearer = `x.${Buffer.from(JSON.stringify({ dct: "org_wrong", tedixSelectedOrganizations: selected })).toString("base64url")}.x`;
			const started = await startExternalAgentSession({
				...bootstrapBase,
				workspace: "connect",
				workspaceCredential: {
					...bootstrapBase.workspaceCredential,
					org: "org_wrong",
				},
				mcpUrl: "https://connect.mcp.tedix.dev/mcp",
				oauthBearer,
				organization: mode === "explicit" ? "tedix" : undefined,
				agentKey: "codex-connect",
				fetch: async () => exchangeResponse(),
				listWorkspaces: async () => [
					{
						org: "55555555-5555-4555-8555-555555555555",
						slug: "other",
						name: "Other",
						gatewayUrl: "https://other.mcp.tedix.dev/mcp",
						descopeTenantId: "org_wrong",
					},
					...(await bootstrapBase.listWorkspaces()),
				],
				createClient: (options) => {
					if (options.headers.Authorization) ownerHeaders.push(options.headers);
					return factory();
				},
			});
			expect(ownerHeaders[0]?.["X-Tedix-Organization"]).toBe(
				mode === "sole selection" ? "org_tedix" : "tedix",
			);
			expect(started.profile.organizationId).toBe(ORG);
			expect(
				code.find((source) => source.includes("organizations.create_api_key")),
			).toContain(`"organizationId":"${ORG}"`);
			const before = code.length;
			await expect(
				startExternalAgentSession({
					...bootstrapBase,
					workspace: "connect",
					mcpUrl: "https://connect.mcp.tedix.dev/mcp",
					oauthBearer,
					organization: "another",
					listWorkspaces: async () => [
						{
							org: "55555555-5555-4555-8555-555555555555",
							slug: "another",
							name: "Other",
							gatewayUrl: null,
							descopeTenantId: "org_wrong",
						},
					],
					createClient: () => factory(),
					fetch: async () => {
						throw new Error("must not exchange wrong organization");
					},
				}),
			).rejects.toThrow("not 55555555");
			await expect(
				resolveExternalAgentAuth({
					workspace: "connect",
					selector: "codex-connect",
					organization: "another",
					fetch: async () => {
						throw new Error("must not exchange");
					},
				}),
			).rejects.toThrow(`Use --organization ${ORG}`);
			expect(code).toHaveLength(before);
		},
	);

	test("separates the Work binding key from MCP capability scopes", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "session-1";
		const code: string[] = [];

		const started = await startExternalAgentSession({
			...bootstrapBase,
			agentKey: "codex-default",
			fetch: async () => exchangeResponse(),
			createClient: scopesBootstrapClient(code),
		});

		expect(extractCreateApiKeyScopes(code)).toEqual([
			"work:read",
			"work:write",
		]);
		expect(started.profile.scopes).toEqual([
			...CAPABILITY_SCOPES,
			"connections.execute",
		]);
	});

	test("honors explicit --agent-scopes opt-in (narrower than the default)", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "session-1";
		const code: string[] = [];

		const started = await startExternalAgentSession({
			...bootstrapBase,
			agentKey: "codex-scoped",
			scopes: ["mcp:tedis.read"],
			fetch: async () => exchangeResponse(),
			createClient: scopesBootstrapClient(code),
		});

		expect(extractCreateApiKeyScopes(code)).toEqual([
			"work:read",
			"work:write",
		]);
		expect(started.profile.scopes).toEqual(["mcp:tedis.read"]);
	});

	test("grants explicitly requested operator scopes only to the AIH credential", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "session-1";
		const code: string[] = [];

		const started = await startExternalAgentSession({
			...bootstrapBase,
			agentKey: "codex-operator",
			scopes: ["platform:admin", "connections.admin", "work:accept"],
			fetch: async () => exchangeResponse(),
			createClient: scopesBootstrapClient(code),
		});

		expect(extractCreateApiKeyScopes(code)).toEqual([
			"work:read",
			"work:write",
			"work:accept",
		]);
		expect(started.profile.scopes).toEqual([
			"platform:admin",
			"connections.admin",
		]);
	});

	test("rejects unknown external-agent scopes instead of silently dropping them", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "session-1";

		await expect(
			startExternalAgentSession({
				...bootstrapBase,
				agentKey: "codex-invalid",
				scopes: ["platform:godmode"],
				fetch: async () => exchangeResponse(),
				createClient: scopesBootstrapClient([]),
			}),
		).rejects.toThrow("Unsupported external-agent scope: platform:godmode");
	});

	// Scopes are granted only when the principal is bootstrapped. Reusing a
	// profile skips that block entirely, so an operator who passed
	// --agent-scopes used to get a confident "Started ..." line and LESS
	// privilege than they asked for, with nothing said. That is the one failure
	// a least-privilege control cannot have.
	test("refuses --agent-scopes that an existing principal cannot be granted", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION = "session-1";

		await startExternalAgentSession({
			...bootstrapBase,
			agentKey: "codex-fixed",
			fetch: async () => exchangeResponse(),
			createClient: scopesBootstrapClient([]),
		});

		await expect(
			startExternalAgentSession({
				...bootstrapBase,
				agentKey: "codex-fixed",
				scopes: ["mcp:apps.admin", "work:accept"],
				fetch: async () => exchangeResponse(),
				createClient: scopesBootstrapClient([]),
			}),
		).rejects.toThrow(/cannot be applied to an existing principal/);

		// Re-stating the scopes the principal already has is not a privilege
		// change, so it must not become a spurious failure.
		await expect(
			startExternalAgentSession({
				...bootstrapBase,
				agentKey: "codex-fixed",
				scopes: [...CAPABILITY_SCOPES, "connections.execute"],
				fetch: async () => exchangeResponse(),
				createClient: scopesBootstrapClient([]),
			}),
		).resolves.toBeDefined();
	});
});

test.each(["same", "different"])(
	"serializes competing first starts for %s principals before issuance",
	async (scenario) => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		let createdKeys = 0;
		let createdPrincipals = 0;
		let exchanges = 0;
		let announce!: () => void;
		let release!: () => void;
		const keyStarted = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const keyGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const common = {
			workspace: "tedix",
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			workspaceCredential: { loginId: "owner", org: "org_tedix" },
			oauthBearer: "owner-token",
			displayName: "Race fixture",
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "openai",
			modelId: "gpt-5.6",
			modelVersion: "2026-07-22",
			listWorkspaces: async () => [
				{
					org: ORG,
					slug: "tedix",
					name: "Tedix",
					gatewayUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
					descopeTenantId: "org_tedix",
				},
			],
			createClient: () => ({
				runCode: async (source: string) => {
					if (source.includes("organizations.create_api_key")) {
						createdKeys++;
						announce();
						await keyGate;
						return {
							result: {
								rawKey: "fixture-secret",
								apiKey: { id: "22222222-2222-4222-8222-222222222222" },
							},
						};
					}
					if (source.includes("external.create_external_agent_principal")) {
						createdPrincipals++;
						return { result: { id: PRINCIPAL } };
					}
					throw new Error("Unexpected gateway operation");
				},
				close: async () => {},
			}),
			fetch: async (_url: string | URL | Request, init?: RequestInit) => {
				exchanges++;
				const input = JSON.parse(String(init?.body));
				const data = (await exchangeResponse().json()) as {
					session: { externalSessionKey: string };
				};
				data.session.externalSessionKey = input.externalSessionKey;
				return Response.json(data, { status: 201 });
			},
		};
		process.env.TEDIX_AGENT_SESSION = "codex:race-one";
		const first = startExternalAgentSession({
			...common,
			agentKey: "race-one",
		});
		await keyStarted;
		process.env.TEDIX_AGENT_SESSION = "codex:race-two";
		const second = startExternalAgentSession({
			...common,
			agentKey: scenario === "same" ? "race-one" : "race-two",
			notice: () => {},
		});
		const outcomes = Promise.allSettled([first, second]);
		release();
		const results = await outcomes;
		// A different key no longer fails: the second session joins the first
		// principal with its own Agent-Session, and nothing extra is issued.
		expect(results.map((result) => result.status)).toEqual([
			"fulfilled",
			"fulfilled",
		]);
		expect(createdKeys).toBe(1);
		expect(createdPrincipals).toBe(1);
		expect(exchanges).toBe(2);
		const stored = JSON.parse(
			readFileSync(join(configDir, "external-agents.json"), "utf8"),
		).workspaces.tedix;
		expect(stored.key).toBe("race-one");
		expect(Object.keys(stored.sessions).sort()).toEqual([
			"codex:race-one",
			"codex:race-two",
		]);
	},
);

describe("one profile shared by parallel harness sessions", () => {
	const owner = {
		workspace: "connect",
		workspaceCredential: { loginId: "owner", org: "org_tedix" },
		mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		oauthBearer: "owner-token",
		harnessVersion: "2.1.293",
		modelProvider: "anthropic",
		modelId: "claude-opus-5-5",
		modelVersion: "claude-opus-5-5",
		listWorkspaces: async () => [
			{
				org: ORG,
				slug: "tedix",
				name: "Tedix",
				gatewayUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				descopeTenantId: "org_tedix",
			},
		],
	} as const;

	function bootstrapClient(code: string[]) {
		return () => ({
			runCode: async (source: string) => {
				code.push(source);
				if (source.includes("organizations.create_api_key"))
					return {
						result: {
							rawKey: "sk_external_secret",
							apiKey: { id: "22222222-2222-4222-8222-222222222222" },
						},
					};
				if (source.includes("external.create_external_agent_principal"))
					return { result: { id: PRINCIPAL } };
				return { result: { success: true } };
			},
			close: async () => {},
		});
	}

	// The server echoes the requested tuple, so each harness session keeps its key.
	const echoExchange = async (
		_url: string | URL | Request,
		init?: RequestInit,
	) => {
		const body = JSON.parse(String(init?.body)) as Record<string, string>;
		const response = (await exchangeResponse().json()) as {
			session: Record<string, unknown>;
			credential: unknown;
		};
		return Response.json(
			{
				...response,
				session: {
					...response.session,
					id: crypto.randomUUID(),
					externalSessionKey: body.externalSessionKey,
					harness: body.harness,
					harnessVersion: body.harnessVersion,
					modelProvider: body.modelProvider,
					modelId: body.modelId,
					modelVersion: body.modelVersion,
				},
			},
			{ status: 201 },
		);
	};

	test("names a new principal for the machine and user when no key is given", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		process.env.TEDIX_AGENT_SESSION =
			"claude-code:11111111-aaaa-4aaa-8aaa-111111111111";
		const code: string[] = [];

		const started = await startExternalAgentSession({
			...owner,
			harness: "claude-code",
			fetch: echoExchange,
			createClient: bootstrapClient(code),
		});

		const expected = defaultLocalPrincipal();
		expect(started.profile.key).toBe(expected.key);
		expect(started.profile.displayName).toBe(expected.displayName);
		expect(
			code.find((source) =>
				source.includes("external.create_external_agent_principal"),
			),
		).toContain(`"key":"${expected.key}"`);
	});

	test("two parallel sessions on one profile get distinct Agent-Sessions under one principal", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		process.env.TEDIX_CONFIG_DIR = configDir;
		const code: string[] = [];
		const notices: string[] = [];

		process.env.TEDIX_AGENT_SESSION =
			"codex:01a0eee2-147e-7493-9c14-e11a4d6d598d";
		const codex = await startExternalAgentSession({
			...owner,
			harness: "codex",
			agentKey: "codex-gtm-01a0f212",
			displayName: "Codex GTM",
			fetch: echoExchange,
			createClient: bootstrapClient(code),
		});

		process.env.TEDIX_AGENT_SESSION =
			"claude-code:3a7952ab-c045-4521-830c-be30b0b69c03";
		const claude = await startExternalAgentSession({
			...owner,
			harness: "claude-code",
			agentKey: "claude-local",
			fetch: echoExchange,
			createClient: bootstrapClient(code),
			notice: (message) => notices.push(message),
		});

		expect(claude.profile.principalId).toBe(codex.profile.principalId);
		expect(codex.session.externalSessionKey).toBe(
			"codex:01a0eee2-147e-7493-9c14-e11a4d6d598d",
		);
		expect(claude.session.externalSessionKey).toBe(
			"claude-code:3a7952ab-c045-4521-830c-be30b0b69c03",
		);
		expect(claude.session.id).not.toBe(codex.session.id);
		expect(Object.keys(claude.profile.sessions).sort()).toEqual([
			"claude-code:3a7952ab-c045-4521-830c-be30b0b69c03",
			"codex:01a0eee2-147e-7493-9c14-e11a4d6d598d",
		]);
		// A differing --agent-key is reported, not fatal, and mints nothing new.
		expect(notices).toEqual([
			expect.stringContaining('--agent-key "claude-local" was ignored'),
		]);
		expect(
			code.filter((source) =>
				source.includes("external.create_external_agent_principal"),
			),
		).toHaveLength(1);
	});

	test("sanitizes machine and user into a valid principal key", () => {
		expect(defaultLocalPrincipal("Ada L", "Adas-MacBook-Pro.local")).toEqual({
			key: "local-ada-l-adas-macbook-pro",
			displayName: "Local coding agents (Ada L@Adas-MacBook-Pro.local)",
		});
		expect(defaultLocalPrincipal("", "")).toEqual({
			key: "local",
			displayName: "Local coding agents (user@machine)",
		});
	});
});

test("renames an existing profile's principal to the machine and user, keeping its key", async () => {
	const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
	dirs.push(configDir);
	process.env.TEDIX_CONFIG_DIR = configDir;
	writeExternalAgentProfile("connect", {
		organizationId: ORG,
		principalId: PRINCIPAL,
		key: "codex-gtm-example",
		displayName: "Codex GTM",
		apiKeyId: "22222222-2222-4222-8222-222222222222",
		rawApiKey: "sk_external_secret",
		scopes: ["mcp:work.read"],
		mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		createdAt: "2026-07-22T00:00:00.000Z",
		sessions: {},
	});
	const code: string[] = [];
	const expected = defaultLocalPrincipal().displayName;

	const renamed = await renameExternalAgentPrincipal({
		workspace: "connect",
		oauthBearer: "owner-token",
		createClient: () => ({
			runCode: async (source: string) => {
				code.push(source);
				return {
					result: {
						id: PRINCIPAL,
						key: "codex-gtm-example",
						displayName: expected,
					},
				};
			},
			close: async () => {},
		}),
	});

	expect(renamed).toEqual({
		key: "codex-gtm-example",
		displayName: expected,
		previous: "Codex GTM",
	});
	expect(code).toHaveLength(1);
	expect(code[0]).toContain("external.rename_external_agent_principal");
	expect(code[0]).toContain(`"principalId":"${PRINCIPAL}"`);
	expect(code[0]).toContain(`"organizationId":"${ORG}"`);
	expect(externalAgentStatus("connect")).toMatchObject({
		key: "codex-gtm-example",
		displayName: expected,
	});
});

test("points an unconfirmed agent-named profile to agent rename, and stays quiet otherwise", async () => {
	const machine = defaultLocalPrincipal().displayName;
	expect(renameNotice("connect", { displayName: "Codex GTM" })).toBe(
		'Notice: every agent session on workspace "connect" appears as "Codex GTM". Name it for this machine with: tedix -w connect agent rename',
	);
	expect(renameNotice("connect", { displayName: machine })).toBeUndefined();
	expect(
		renameNotice("connect", {
			displayName: "Ada's review bots",
			displayNameConfirmedAt: "2026-10-08T00:00:00.000Z",
		}),
	).toBeUndefined();

	const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
	dirs.push(configDir);
	process.env.TEDIX_CONFIG_DIR = configDir;
	process.env.TEDIX_AGENT_SESSION = "codex:session-1";
	writeExternalAgentProfile("connect", {
		organizationId: ORG,
		principalId: PRINCIPAL,
		key: "codex-gtm-example",
		displayName: "Codex GTM",
		apiKeyId: "22222222-2222-4222-8222-222222222222",
		rawApiKey: "sk_external_secret",
		scopes: ["mcp:work.read"],
		mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		createdAt: "2026-07-22T00:00:00.000Z",
		sessions: {},
	});
	const notices: string[] = [];
	await startExternalAgentSession({
		workspace: "connect",
		mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		harness: "codex",
		harnessVersion: "1.2.3",
		modelProvider: "openai",
		modelId: "gpt-5.6",
		modelVersion: "2026-07-22",
		fetch: async () => exchangeResponse(),
		notice: (message) => notices.push(message),
	});
	expect(notices).toEqual([
		expect.stringContaining("tedix -w connect agent rename"),
	]);

	// Renaming confirms the name, so the next start is quiet.
	await renameExternalAgentPrincipal({
		workspace: "connect",
		oauthBearer: "owner-token",
		displayName: "Ada's review bots",
		createClient: () => ({
			runCode: async () => ({
				result: { id: PRINCIPAL, displayName: "Ada's review bots" },
			}),
			close: async () => {},
		}),
	});
	notices.length = 0;
	await startExternalAgentSession({
		workspace: "connect",
		mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		harness: "codex",
		harnessVersion: "1.2.3",
		modelProvider: "openai",
		modelId: "gpt-5.6",
		modelVersion: "2026-07-22",
		fetch: async () => exchangeResponse(),
		notice: (message) => notices.push(message),
	});
	expect(notices).toEqual([]);
});
