import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	externalAgentSessionWorkspaces,
	readExternalAgentProfile,
	readExternalAgentCredential,
	writeExternalAgentCredential,
	removeExternalAgentSession,
	writeExternalAgentProfile,
	writeExternalAgentSession,
} from "./external-agent-store";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("external-agent credential store", () => {
	test("round-trips a profile and hardens the secret file to 0600", () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		writeExternalAgentProfile(
			"tedix",
			{
				organizationId: "org-id",
				principalId: "principal-id",
				key: "codex-ada",
				displayName: "Ada Codex",
				apiKeyId: "api-key-id",
				rawApiKey: "sk_secret_never_render",
				scopes: ["platform:admin"],
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				createdAt: "2026-07-22T00:00:00.000Z",
				sessions: {
					"codex:session-1": {
						id: "session-id",
						externalSessionKey: "codex:session-1",
						harness: "codex",
						harnessVersion: "1.2.3",
						modelProvider: "openai",
						modelId: "gpt-5.6",
						modelVersion: "2026-07-22",
						startedAt: "2026-07-22T00:00:00.000Z",
					},
				},
			},
			{ configDir },
		);

		expect(statSync(join(configDir, "external-agents.json")).mode & 0o777).toBe(
			0o600,
		);
		expect(readExternalAgentProfile("tedix", { configDir })?.rawApiKey).toBe(
			"sk_secret_never_render",
		);

		const profile = readExternalAgentProfile("tedix", { configDir })!;
		const session = profile.sessions["codex:session-1"]!;
		writeExternalAgentCredential(
			"tedix",
			profile,
			session,
			"cached-token-secret",
			Date.now() + 60_000,
			{ configDir },
		);
		expect(
			readExternalAgentCredential("tedix", profile, session, { configDir }),
		).toBe("cached-token-secret");
		expect(
			JSON.stringify(readExternalAgentProfile("tedix", { configDir })),
		).not.toContain("cached-token-secret");
		for (const changed of [
			{ ...profile, organizationId: "other-org" },
			{ ...profile, principalId: "other-agent" },
			{ ...profile, rawApiKey: "sk_rotated" },
			{ ...profile, mcpUrl: "https://other.example/mcp" },
			{ ...profile, scopes: [] },
		])
			expect(
				readExternalAgentCredential("tedix", changed, session, { configDir }),
			).toBeUndefined();
		expect(
			readExternalAgentCredential(
				"tedix",
				profile,
				{ ...session, id: "other-session" },
				{ configDir },
			),
		).toBeUndefined();
		writeExternalAgentCredential(
			"tedix",
			profile,
			session,
			"expired",
			Date.now() - 1,
			{ configDir },
		);
		expect(
			readExternalAgentCredential("tedix", profile, session, { configDir }),
		).toBeUndefined();
		writeExternalAgentCredential(
			"tedix",
			profile,
			session,
			"cached-token-secret",
			Date.now() + 60_000,
			{ configDir },
		);

		removeExternalAgentSession("tedix", "codex:session-1", { configDir });
		expect(
			readExternalAgentCredential("tedix", profile, session, { configDir }),
		).toBeUndefined();
		expect(readExternalAgentProfile("tedix", { configDir })?.sessions).toEqual(
			{},
		);
	});
});

describe("externalAgentSessionWorkspaces", () => {
	/**
	 * The lookup behind `sessionWorkspaceDrift`. A session recorded under one
	 * workspace must not appear bound to another, or the guard that refuses a
	 * drifted cross-organization write would pass it through.
	 */
	function seed() {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-session-binding-"));
		dirs.push(configDir);
		const base = {
			organizationId: "org-id",
			principalId: "principal-id",
			displayName: "Agent",
			apiKeyId: "api-key-id",
			rawApiKey: "sk_secret",
			scopes: ["platform:admin"],
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			createdAt: "2026-07-22T00:00:00.000Z",
		};
		const session = (key: string) => ({
			id: `id-${key}`,
			externalSessionKey: key,
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "openai",
			modelId: "gpt-5.6",
			modelVersion: "2026-07-22",
			startedAt: "2026-07-22T00:00:00.000Z",
		});
		writeExternalAgentProfile(
			"tedix",
			{
				...base,
				key: "agent-a",
				sessions: { "codex:one": session("codex:one") },
			},
			{ configDir },
		);
		writeExternalAgentProfile(
			"acme-chat-recovery",
			{
				...base,
				key: "agent-b",
				sessions: { "codex:two": session("codex:two") },
			},
			{ configDir },
		);
		return configDir;
	}

	test("reports only the workspace that records the session", () => {
		const configDir = seed();
		expect(externalAgentSessionWorkspaces("codex:one", { configDir })).toEqual([
			"tedix",
		]);
		expect(externalAgentSessionWorkspaces("codex:two", { configDir })).toEqual([
			"acme-chat-recovery",
		]);
	});

	test("reports every workspace when one session spans two", () => {
		const configDir = seed();
		const shared = {
			id: "id-shared",
			externalSessionKey: "codex:one",
			harness: "codex",
			harnessVersion: "1.2.3",
			modelProvider: "openai",
			modelId: "gpt-5.6",
			modelVersion: "2026-07-22",
			startedAt: "2026-07-22T00:00:00.000Z",
		};
		writeExternalAgentProfile(
			"acme-chat-recovery",
			{
				organizationId: "org-id",
				principalId: "principal-id",
				key: "agent-b",
				displayName: "Agent",
				apiKeyId: "api-key-id",
				rawApiKey: "sk_secret",
				scopes: ["platform:admin"],
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				createdAt: "2026-07-22T00:00:00.000Z",
				sessions: { "codex:one": shared },
			},
			{ configDir },
		);
		expect(
			externalAgentSessionWorkspaces("codex:one", { configDir }).sort(),
		).toEqual(["acme-chat-recovery", "tedix"]);
	});

	test("returns nothing for an unrecorded or blank session", () => {
		const configDir = seed();
		expect(
			externalAgentSessionWorkspaces("codex:absent", { configDir }),
		).toEqual([]);
		expect(externalAgentSessionWorkspaces("   ", { configDir })).toEqual([]);
	});

	/** Mirrors `findStoredSession`: a bare id matches by harness-stripped suffix. */
	test("matches a bare session id by suffix", () => {
		const configDir = seed();
		expect(externalAgentSessionWorkspaces("one", { configDir })).toEqual([
			"tedix",
		]);
	});
});

function concurrentProfile() {
	return {
		organizationId: "org",
		principalId: "principal",
		key: "agent",
		displayName: "Agent",
		apiKeyId: "key",
		rawApiKey: "test-secret",
		scopes: ["mcp:work.read"],
		mcpUrl: "https://example.invalid/mcp",
		createdAt: "2026-10-04",
		sessions: {},
	};
}
function concurrentSession(key: string) {
	return {
		id: key,
		externalSessionKey: key,
		harness: "codex",
		harnessVersion: "1",
		modelProvider: "openai",
		modelId: "gpt-6",
		modelVersion: "1",
		startedAt: "2026-10-04",
	};
}

describe("external-agent concurrent storage", () => {
	test("rejects principal replacement and preserves peer sessions without resurrecting removals", () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		const profile = concurrentProfile();
		writeExternalAgentProfile("connect", profile, { configDir });
		writeExternalAgentSession("connect", profile, concurrentSession("one"), {
			configDir,
		});
		const stale = readExternalAgentProfile("connect", { configDir })!;
		writeExternalAgentSession("connect", stale, concurrentSession("two"), {
			configDir,
		});
		expect(() =>
			writeExternalAgentProfile(
				"connect",
				{ ...profile, principalId: "intruder" },
				{ configDir },
			),
		).toThrow("changed concurrently");
		removeExternalAgentSession("connect", "one", { configDir });
		writeExternalAgentSession("connect", stale, concurrentSession("three"), {
			configDir,
		});
		expect(
			Object.keys(
				readExternalAgentProfile("connect", { configDir })!.sessions,
			).sort(),
		).toEqual(["three", "two"]);
		writeExternalAgentCredential(
			"connect",
			stale,
			stale.sessions.one!,
			"stale-token",
			Date.now() + 60_000,
			{ configDir },
		);
		expect(
			readExternalAgentCredential("connect", stale, stale.sessions.one!, {
				configDir,
			}),
		).toBeUndefined();
	});
	test("independent processes preserve simultaneous workspace and session writes", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "tedix-external-agent-"));
		dirs.push(configDir);
		const modulePath = new URL("./external-agent-store.ts", import.meta.url)
			.pathname;
		const profile = concurrentProfile();
		writeExternalAgentProfile("connect", profile, { configDir });
		const workers = Array.from({ length: 4 }, (_, n) => {
			const code = `import {writeExternalAgentProfile,writeExternalAgentSession,readExternalAgentProfile,writeExternalAgentCredential,removeExternalAgentSession} from ${JSON.stringify(modulePath)};
			const configDir=${JSON.stringify(configDir)}, profile=${JSON.stringify(profile)};
			writeExternalAgentProfile("peer-${n}",profile,{configDir});
			for(let i=0;i<8;i++){const key="session-${n}-"+i;const session={...${JSON.stringify(concurrentSession("fixture"))},id:key,externalSessionKey:key};writeExternalAgentSession("connect",profile,session,{configDir});writeExternalAgentCredential("connect",profile,session,"fixture-token",Date.now()+60000,{configDir});if(i===0) removeExternalAgentSession("connect",key,{configDir});}
			if(!readExternalAgentProfile("peer-${n}",{configDir})) throw new Error("lost workspace");`;
			return Bun.spawn([process.execPath, "-e", code], {
				stdout: "pipe",
				stderr: "pipe",
			});
		});
		for (const worker of workers) {
			const error = await new Response(worker.stderr).text();
			expect(await worker.exited, error).toBe(0);
		}
		expect(
			Object.keys(readExternalAgentProfile("connect", { configDir })!.sessions),
		).toHaveLength(28);
		for (let n = 0; n < 4; n++)
			expect(
				readExternalAgentProfile(`peer-${n}`, { configDir })?.principalId,
			).toBe("principal");
	});
});
