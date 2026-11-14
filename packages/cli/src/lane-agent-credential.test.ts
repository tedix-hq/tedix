import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveExternalAgentAuth,
	writeLaneExternalAgentCredential,
} from "./external-agent";
import {
	readExternalAgentProfile,
	writeExternalAgentCredential,
	writeExternalAgentProfile,
} from "./external-agent-store";

const dirs: string[] = [];
const saved = {
	config: process.env.TEDIX_CONFIG_DIR,
	lane: process.env.TEDIX_LANE_AGENT_STORE,
	session: process.env.TEDIX_AGENT_SESSION,
};

afterEach(() => {
	for (const [key, value] of [
		["TEDIX_CONFIG_DIR", saved.config],
		["TEDIX_LANE_AGENT_STORE", saved.lane],
		["TEDIX_AGENT_SESSION", saved.session],
	] as const)
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	for (const dir of dirs.splice(0)) {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

const sessionKey = "devin:lane-session-1";
const profile = {
	organizationId: "org-id",
	principalId: "principal-id",
	key: "devin-local-ada",
	displayName: "Ada Devin",
	apiKeyId: "api-key-id",
	rawApiKey: "sk_host_secret_never_in_lane",
	scopes: ["mcp:work.read"],
	mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
	createdAt: "2026-11-14T00:00:00.000Z",
	sessions: {
		[sessionKey]: {
			id: "session-id",
			externalSessionKey: sessionKey,
			harness: "devin",
			harnessVersion: "1.0.0",
			modelProvider: "devin",
			modelId: "swe-1.5",
			modelVersion: "unpinned",
			startedAt: "2026-11-14T00:00:00.000Z",
		},
	},
};

function temp() {
	const dir = mkdtempSync(join(tmpdir(), "tedix-lane-agent-"));
	dirs.push(dir);
	return dir;
}

describe("Devin lane credential handoff", () => {
	test("a denied host store read says access denied, not corrupt", () => {
		const configDir = temp();
		writeFileSync(join(configDir, "external-agents.json"), "{}", {
			mode: 0o000,
		});
		expect(() => readExternalAgentProfile("connect", { configDir })).toThrow(
			/Access denied reading .*external-agents\.json/,
		);
		chmodSync(join(configDir, "external-agents.json"), 0o600);
		writeFileSync(join(configDir, "external-agents.json"), "not json");
		expect(() => readExternalAgentProfile("connect", { configDir })).toThrow(
			/corrupt or unreadable/,
		);
	});

	test("the lane store carries one session token and no enrollment secret", async () => {
		const host = temp();
		const lane = join(temp(), "tedix-agent");
		process.env.TEDIX_CONFIG_DIR = host;
		writeExternalAgentProfile("connect", profile);
		writeExternalAgentProfile("connect", {
			...profile,
			sessions: {
				"devin:other-session": {
					...profile.sessions[sessionKey]!,
					id: "other",
					externalSessionKey: "devin:other-session",
				},
			},
		});
		const stored = readExternalAgentProfile("connect")!;
		writeExternalAgentCredential(
			"connect",
			stored,
			stored.sessions[sessionKey]!,
			"lane-session-token",
			Date.now() + 200_000,
		);

		const result = await writeLaneExternalAgentCredential({
			workspace: "connect",
			sessionKey,
			storeDir: lane,
			fetch: () => {
				throw new Error("a fresh cache needs no exchange");
			},
		});
		expect(result.principalKey).toBe("devin-local-ada");
		const written = readFileSync(join(lane, "external-agents.json"), "utf8");
		expect(written).not.toContain("sk_host_secret_never_in_lane");
		expect(written).not.toContain("devin:other-session");

		// Inside the lane the host store is unreachable; only the lane store is read.
		chmodSync(join(host, "external-agents.json"), 0o000);
		process.env.TEDIX_LANE_AGENT_STORE = lane;
		process.env.TEDIX_AGENT_SESSION = sessionKey;
		const auth = await resolveExternalAgentAuth({
			workspace: "connect",
			selector: "devin-local-ada",
			fetch: () => {
				throw new Error("the lane never exchanges");
			},
		});
		expect(auth.headers).toEqual({
			Authorization: "Bearer lane-session-token",
		});
		chmodSync(join(host, "external-agents.json"), 0o600);
	});

	test("an expired lane token asks for the dispatcher renewal, not an exchange", async () => {
		const lane = temp();
		process.env.TEDIX_LANE_AGENT_STORE = lane;
		process.env.TEDIX_AGENT_SESSION = sessionKey;
		const { rawApiKey: _secret, ...shared } = profile;
		writeExternalAgentProfile("connect", {
			...shared,
			credentialSource: "proxy",
		});
		await expect(
			resolveExternalAgentAuth({
				workspace: "connect",
				selector: "devin-local-ada",
				fetch: () => {
					throw new Error("the lane never exchanges");
				},
			}),
		).rejects.toThrow(/lane's Tedix credential expired/);
	});
});
