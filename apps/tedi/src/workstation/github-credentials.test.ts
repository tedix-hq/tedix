import { describe, expect, it, vi } from "vite-plus/test";
import type { TediConfig } from "../types";
import type { WorkstationRuntimeBody } from "./computer-body";

vi.mock("@cloudflare/sandbox", () => ({
	ProcessWaitTimeoutError: class extends Error {},
}));

type TestBody = WorkstationRuntimeBody &
	Record<
		"nativeExec" | "nativeStatus" | "nativeStart" | "nativeKill" | "writeFile",
		ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>
	>;
vi.mock("./computer-body", async (importOriginal) => ({
	...(await importOriginal<typeof import("./computer-body")>()),
	workstationExec: (body: TestBody, ...args: unknown[]) =>
		body.nativeExec(...args),
	workstationStart: (body: TestBody, ...args: unknown[]) =>
		body.nativeStart(...args),
	workstationExecutionStatus: (body: TestBody, ...args: unknown[]) =>
		body.nativeStatus(...args),
	workstationKill: (body: TestBody, ...args: unknown[]) =>
		body.nativeKill(...args),
	workstationWriteFile: (body: TestBody, ...args: unknown[]) =>
		(body.writeFile as (...args: unknown[]) => unknown)(...args),
}));

import {
	hydrateGitHubCliCredentials,
	hydrateGitIdentity,
	probeGitHubCliCredentials,
} from "./github-credentials";

describe("hydrateGitHubCliCredentials", () => {
	it("keeps GitHub authority off the workstation filesystem", async () => {
		const sandbox = {
			nativeExec: vi
				.fn()
				.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
			writeFile: vi.fn().mockResolvedValue(undefined),
		} as unknown as TestBody;
		const config = {
			secrets: { GITHUB_PAT: "github-token" },
			repoConfig: { branch: "main", repoUrl: "https://github.com/tedix/tedix" },
		} as unknown as TediConfig;

		const result = await hydrateGitHubCliCredentials(sandbox, config, {
			configDir: "/home/tedi/.config/gh",
			ghHostsPath: "/home/tedi/.config/gh/hosts.yml",
			gitCredentialsPath: "/home/tedi/.git-credentials",
		});

		expect(result).toEqual({ configured: true, status: "brokered" });
		const commands = sandbox.nativeExec.mock.calls.map(([command]) =>
			String(command),
		);
		expect(commands.join("\n")).toContain("rm -f --");
		expect(commands.join("\n")).toContain("--unset-all credential.helper");
		expect(commands.join("\n")).toContain(
			"--unset-all http.https://github.com/.proactiveAuth",
		);
		expect(commands.join("\n")).not.toContain("github-token");
		expect(commands.join("\n")).not.toContain("extraHeader");
		expect(sandbox.writeFile).not.toHaveBeenCalled();
		expect(sandbox.nativeExec).toHaveBeenLastCalledWith(
			expect.stringContaining(
				"git config --global credential.interactive false",
			),
			{ timeout: 30_000 },
		);
		expect(sandbox.nativeExec).toHaveBeenLastCalledWith(
			expect.stringContaining("git config --global http.lowSpeedTime 30"),
			{ timeout: 30_000 },
		);
	});

	it("scrubs legacy credentials when no repository is configured", async () => {
		const sandbox = {
			nativeExec: vi
				.fn()
				.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
			writeFile: vi.fn(),
		} as unknown as TestBody;
		const config = { secrets: {} } as unknown as TediConfig;

		await expect(hydrateGitHubCliCredentials(sandbox, config)).resolves.toEqual(
			{
				configured: false,
				status: "missing",
			},
		);
		expect(sandbox.nativeExec).toHaveBeenCalledTimes(2);
		expect(
			sandbox.nativeExec.mock.calls
				.map(([command]) => String(command))
				.join("\n"),
		).toContain("rm -f --");
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});
});

describe("probeGitHubCliCredentials", () => {
	it.each([
		[{ status: "valid", httpStatus: 200 }, "valid"],
		[{ status: "invalid", httpStatus: 401 }, "invalid"],
		[
			{
				status: "rate_limited",
				httpStatus: 429,
				responseHeaders: { "retry-after": "300" },
			},
			"rate_limited",
		],
	] as const)("returns the sanitized %s result", async (payload, status) => {
		const sandbox = {
			nativeExec: vi.fn().mockResolvedValue({
				exitCode: 0,
				stdout: JSON.stringify(payload),
				stderr: "",
			}),
		} as unknown as TestBody;

		await expect(
			probeGitHubCliCredentials(sandbox, "tedix/tedix"),
		).resolves.toMatchObject({
			status,
		});
		const command = String(sandbox.nativeExec.mock.calls[0]?.[0]);
		expect(command).toContain('"gh"');
		expect(command).toContain('"api"');
		expect(command).toContain("repos/tedix/tedix");
		expect(command).not.toContain("github-token");
	});

	it.each([
		{ exitCode: 1, stdout: "", stderr: "failed" },
		{ exitCode: 0, stdout: "not json", stderr: "" },
		{ exitCode: 0, stdout: '{"status":"mystery"}', stderr: "" },
		{ exitCode: 0, stdout: '{"status":"valid"}', stderr: "", timedOut: true },
	])("fails closed without returning provider output: %j", async (result) => {
		const sandbox = {
			nativeExec: vi.fn().mockResolvedValue(result),
		} as unknown as TestBody;
		await expect(
			probeGitHubCliCredentials(sandbox, "tedix/tedix"),
		).resolves.toEqual({
			status: "unavailable",
		});
	});
});

describe("hydrateGitIdentity", () => {
	function identitySandbox(): TestBody {
		return {
			nativeExec: vi
				.fn()
				.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
			writeFile: vi.fn().mockResolvedValue(undefined),
		} as unknown as TestBody;
	}

	it("commits as the tedi's own first-class identity", async () => {
		const sandbox = identitySandbox();
		const config = {
			displayName: "CTO",
			slug: "cto",
			secrets: {},
		} as unknown as TediConfig;

		const result = await hydrateGitIdentity(sandbox, config);

		expect(result).toEqual({ email: "cto@tedix.tech", name: "CTO" });
		expect(sandbox.nativeExec).toHaveBeenCalledWith(
			"git config --global user.name 'CTO' && git config --global user.email 'cto@tedix.tech'",
			{ timeout: 30_000 },
		);
	});

	it("falls back to the slug when the tedi has no display name", async () => {
		const sandbox = identitySandbox();
		const config = {
			displayName: "   ",
			slug: "cmo",
			secrets: {},
		} as unknown as TediConfig;

		const result = await hydrateGitIdentity(sandbox, config);

		expect(result).toEqual({ email: "cmo@tedix.tech", name: "cmo" });
		expect(sandbox.nativeExec).toHaveBeenCalledWith(
			expect.stringContaining("git config --global user.name 'cmo'"),
			{ timeout: 30_000 },
		);
	});

	it("quotes an identity that carries shell metacharacters", async () => {
		const sandbox = identitySandbox();
		const config = {
			displayName: "Ana's Tedi; rm -rf /",
			slug: "ana",
			secrets: {},
		} as unknown as TediConfig;

		await hydrateGitIdentity(sandbox, config);

		expect(sandbox.nativeExec).toHaveBeenCalledWith(
			"git config --global user.name 'Ana'\\''s Tedi; rm -rf /' && git config --global user.email 'ana@tedix.tech'",
			{ timeout: 30_000 },
		);
	});
});

it.each([{ timedOut: true }, { truncated: true }, { signal: 15 }])(
	"rejects incomplete credential configuration %j",
	async (extra) => {
		const body = {
			nativeExec: vi
				.fn()
				.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", ...extra }),
		} as unknown as TestBody;
		await expect(
			hydrateGitIdentity(body, {
				slug: "cto",
				displayName: "CTO",
			} as TediConfig),
		).rejects.toThrow("credential configuration failed");
	},
);
