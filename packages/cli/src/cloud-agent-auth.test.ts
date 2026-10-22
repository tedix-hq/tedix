import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalAgentSessionExchangeInputSchema } from "@tedix/api-contract/contracts/external-agent-identity";
import {
	externalAgentStatus,
	resolveExternalAgentAuth,
	startExternalAgentSession,
} from "./external-agent";
import { readExternalAgentProfile } from "./external-agent-store";
import { TedixHomeClient } from "./home-client";

const organizationId = "11111111-1111-4111-8111-111111111111";
const principalId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const url = "https://gateway.example.test/mcp";
const envKeys = [
	"TEDIX_CONFIG_DIR",
	"TEDIX_ORGANIZATION",
	"TEDIX_EXTERNAL_AGENT",
	"TEDIX_EXTERNAL_AGENT_PRINCIPAL_ID",
	"TEDIX_AGENT_KEY",
	"TEDIX_AGENT_SESSION",
] as const;
const savedEnv = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
);
const dirs: string[] = [];

afterEach(() => {
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function setup(key: string) {
	const dir = mkdtempSync(join(tmpdir(), "tedix-cloud-auth-"));
	dirs.push(dir);
	Object.assign(process.env, {
		TEDIX_CONFIG_DIR: dir,
		TEDIX_ORGANIZATION: organizationId,
		TEDIX_EXTERNAL_AGENT: "cloud-test",
		TEDIX_EXTERNAL_AGENT_PRINCIPAL_ID: principalId,
		TEDIX_AGENT_KEY: key,
		TEDIX_AGENT_SESSION: "codex:cloud-test-session",
	});
	return dir;
}

function exchange(token: string) {
	return Response.json({
		session: {
			id: sessionId,
			organizationId,
			principalId,
			externalSessionKey: "codex:cloud-test-session",
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "example",
			modelId: "test-model",
			modelVersion: "test-version",
			identitySource: "explicit",
			status: "active",
			creditEligible: true,
			startedAt: "2026-10-20T00:00:00.000Z",
			lastSeenAt: "2026-10-20T00:00:00.000Z",
			endedAt: null,
			metadata: {},
		},
		credential: {
			accessToken: token,
			clientRecordId: "test-client",
			expiresIn: 120,
			mcpServerUrl: url,
		},
	});
}

const startOptions = {
	workspace: "cloud",
	mcpUrl: url,
	harness: "codex",
	harnessVersion: "1.2.3",
	modelProvider: "example",
	modelId: "test-model",
	modelVersion: "test-version",
};

test.each(["bootstrap-secret", "proxy-injected"])(
	"boots without owner OAuth using %s and renews bearer during one command",
	async (key) => {
		const dir = setup(key);
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		let exchanges = 0;
		const exchangeFetch = async (_input: unknown, init?: RequestInit) => {
			const input = ExternalAgentSessionExchangeInputSchema.parse(
				JSON.parse(String(init?.body)),
			);
			expect(input.scopes).toEqual(["mcp:work.read", "mcp:observe.read"]);
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBeNull();
			expect(headers.get("X-API-Key")).toBe(
				key === "proxy-injected" ? null : key,
			);
			return exchange(`bearer-${++exchanges}`);
		};
		try {
			await startExternalAgentSession({
				...startOptions,
				fetch: exchangeFetch,
			});
			expect(readExternalAgentProfile("cloud")?.credentialSource).toBe(
				key === "proxy-injected" ? "proxy" : "env",
			);
			expect(
				readFileSync(join(dir, "external-agents.json"), "utf8"),
			).not.toContain(key);
			expect(JSON.stringify(externalAgentStatus("cloud"))).not.toMatch(
				/bootstrap-secret|bearer-/,
			);
			const auth = await resolveExternalAgentAuth({
				workspace: "cloud",
				selector: "cloud-test",
				fetch: exchangeFetch,
			});
			const seen: string[] = [];
			const client = new TedixHomeClient({
				headers: auth.headers,
				credentialProvider: auth.credentialProvider,
				url,
				fetch: async (_input, init) => {
					const headers = new Headers(init?.headers);
					expect(headers.get("X-API-Key")).toBeNull();
					seen.push(headers.get("Authorization")!);
					const request = JSON.parse(String(init?.body));
					return Response.json({ jsonrpc: "2.0", id: request.id, result: {} });
				},
			});
			try {
				await client.discoverProtocol();
				const before = exchanges;
				now += 59_000;
				await client.discoverProtocol();
				expect(exchanges).toBe(before);
				now += 1_000;
				await Promise.all([
					client.discoverProtocol(),
					client.discoverProtocol(),
				]);
				expect(exchanges).toBe(before + 1);
				expect(seen).toEqual([
					`Bearer bearer-${before}`,
					`Bearer bearer-${before}`,
					`Bearer bearer-${before + 1}`,
					`Bearer bearer-${before + 1}`,
				]);
			} finally {
				await client.close();
			}
		} finally {
			clock.mockRestore();
		}
	},
);

test.each([
	["principal_inactive", "inactive"],
	["enrollment_expired", "expired"],
	["credential_binding_mismatch", "binding"],
	["session_backend_unavailable", "temporarily unavailable"],
])(
	"%s explains recovery without echoing server secrets",
	async (code, message) => {
		setup("bootstrap-secret");
		const error = await startExternalAgentSession({
			...startOptions,
			fetch: async () =>
				Response.json({ code, error: "bootstrap-secret" }, { status: 403 }),
		}).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain(message);
		expect(String(error)).not.toContain("bootstrap-secret");
	},
);

test.each(["bootstrap-secret", "proxy-injected"])(
	"agent start --json uses %s without stored login and redacts secrets",
	async (key) => {
		setup(key);
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				expect(new URL(request.url).pathname).toBe("/external-agents/session");
				expect(request.headers.get("Authorization")).toBeNull();
				expect(request.headers.get("X-API-Key")).toBe(
					key === "proxy-injected" ? null : key,
				);
				ExternalAgentSessionExchangeInputSchema.parse(await request.json());
				return exchange("private-issued-token");
			},
		});
		try {
			const child = Bun.spawn(
				[
					process.execPath,
					fileURLToPath(new URL("./index.ts", import.meta.url)),
					"-w",
					"cloud",
					"--url",
					`http://127.0.0.1:${server.port}/mcp`,
					"agent",
					"start",
					"--agent-harness",
					"codex",
					"--agent-harness-version",
					"1.2.3",
					"--model-provider",
					"example",
					"--model-id",
					"test-model",
					"--model-version",
					"test-version",
					"--json",
				],
				{ env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			expect(JSON.parse(stdout)).toMatchObject({
				principalId,
				principalKey: "cloud-test",
			});
			expect(stdout + stderr).not.toMatch(
				/bootstrap-secret|private-issued-token/,
			);
		} finally {
			server.stop(true);
		}
	},
);
