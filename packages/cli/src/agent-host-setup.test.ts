import {
	HUMAN_CONNECT_CONSENT_SCOPES,
	selectConsentPreset,
	isReadOnlyConsentSelection,
} from "@tedix/mcp-shared/auth/consent-scopes";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	parseAgentHostSetupArgs,
	runAgentHostSetup,
	type HostCommandRunner,
} from "./agent-host-setup";

const originalLog = console.log;
const originalError = console.error;
afterEach(() => {
	console.log = originalLog;
	console.error = originalError;
});

function fakeRunner(input: {
	claudeInstalled?: boolean;
	codexInstalled?: boolean;
	marketplaceSource?: string;
	claudeMarketplaceSource?: "github" | "directory";
	versionAfterUpdate?: string;
	codexModernProtocol?: "true" | "false" | "unavailable";
	unavailable?: "codex" | "claude";
}) {
	const calls: Array<{
		command: string;
		args: string[];
		interactive: boolean;
	}> = [];
	const installed = {
		codex: input.codexInstalled ?? false,
		claude: input.claudeInstalled ?? false,
	};
	const versions = { codex: "0.1.1", claude: "0.1.1" };
	const runner: HostCommandRunner = (command, args, interactive = false) => {
		calls.push({ command, args, interactive });
		if (args[0] === "--version")
			return {
				status: command === input.unavailable ? 127 : 0,
				stdout: "1.0.0",
				stderr: "",
			};
		if (args.join(" ") === "plugin list --json")
			return {
				status: 0,
				stdout: JSON.stringify(
					command === "codex"
						? {
								installed: installed.codex
									? [
											{
												pluginId: "tedix@tedix-repo",
												enabled: true,
												version: versions.codex,
											},
										]
									: [],
							}
						: installed.claude
							? [{ id: "tedix@tedix", enabled: true, version: versions.claude }]
							: [],
				),
				stderr: "",
			};
		if (args.join(" ") === "plugin marketplace list --json")
			return {
				status: 0,
				stdout: JSON.stringify(
					command === "codex"
						? {
								marketplaces: input.marketplaceSource
									? [
											{
												name: "tedix-repo",
												marketplaceSource: {
													sourceType: input.marketplaceSource.startsWith("/")
														? "local"
														: "git",
													source: input.marketplaceSource,
												},
											},
										]
									: [],
							}
						: input.claudeMarketplaceSource
							? [
									{
										name: "tedix",
										source: input.claudeMarketplaceSource,
										...(input.claudeMarketplaceSource === "github"
											? { repo: "tedix-hq/tedix" }
											: { path: "/tmp/tedix" }),
									},
								]
							: [],
				),
				stderr: "",
			};
		if (args[0] === "plugin" && args[1] === "add" && command === "codex")
			installed.codex = true;
		if (args[0] === "plugin" && args[1] === "install" && command === "claude")
			installed.claude = true;
		if (args[0] === "plugin" && ["add", "update"].includes(args[1] ?? ""))
			versions[command] = input.versionAfterUpdate ?? "0.1.2";
		if (args.join(" ") === "mcp list")
			return {
				status: 0,
				stdout:
					"tedix  https://connect.mcp.tedix.dev/mcp  -  enabled  Not logged in",
				stderr: "",
			};
		if (args.join(" ") === "features list" && command === "codex")
			return input.codexModernProtocol === "unavailable"
				? { status: 1, stdout: "", stderr: "feature list unavailable" }
				: {
						status: 0,
						stdout: `mcp_2026_07_28  under development  ${input.codexModernProtocol ?? "false"}\n`,
						stderr: "",
					};
		return { status: 0, stdout: "", stderr: "" };
	};
	return { calls, runner };
}

describe("agent host setup", () => {
	it("leaves scope discovery to Connect with read-only consent and no setup override", async () => {
		const manifest = await Bun.file(
			new URL("../../../plugins/tedix/.mcp.json", import.meta.url),
		).json();
		expect(manifest.mcpServers.tedix.oauth).toBeUndefined();
		const choices = HUMAN_CONNECT_CONSENT_SCOPES;
		const selected = selectConsentPreset(
			choices.map((name: string) => ({ name })),
			"read",
		);
		expect(selected).toContain("connections.read");
		expect(selected).not.toContain("connections.execute");
		expect(selected).not.toContain("connections.admin");
		expect(isReadOnlyConsentSelection(selected)).toBe(true);
		const lines: string[] = [];
		console.log = mock((line: string) => lines.push(line));
		expect(
			await runAgentHostSetup(["--codex", "--yes"], fakeRunner({}).runner),
		).toBe(0);
		expect(lines.join("\n")).toContain("codex mcp login tedix");
		expect(lines.join("\n")).not.toContain("--scopes");
		expect(lines.join("\n")).toContain("review fresh consent");
	});

	it("accepts a simple host selection and rejects conflicting options", () => {
		expect(parseAgentHostSetupArgs(["--codex", "--claude", "--yes"])).toEqual({
			dryRun: false,
			hosts: ["codex", "claude"],
			status: false,
			update: false,
			yes: true,
		});
		expect(() => parseAgentHostSetupArgs(["--all", "--codex"])).toThrow();
	});

	it("installs through both host CLIs and verifies the installed plugins", async () => {
		console.log = mock(() => {});
		const { calls, runner } = fakeRunner({});
		expect(await runAgentHostSetup(["--all", "--yes"], runner)).toBe(0);
		expect(
			calls
				.filter(({ interactive }) => interactive)
				.map(({ command, args }) => `${command} ${args.join(" ")}`),
		).toEqual([
			"codex plugin marketplace add tedix-hq/tedix",
			"codex plugin add tedix@tedix-repo",
			"claude plugin marketplace add tedix-hq/tedix",
			"claude plugin install tedix@tedix --scope user",
		]);
	});

	it("does not alter an existing installation or an unexpected marketplace", async () => {
		console.log = mock(() => {});
		console.error = mock(() => {});
		const existing = fakeRunner({
			codexInstalled: true,
			claudeInstalled: true,
		});
		expect(await runAgentHostSetup(["--all", "--yes"], existing.runner)).toBe(
			0,
		);
		expect(existing.calls.some((call) => call.interactive)).toBe(false);

		const collision = fakeRunner({ marketplaceSource: "unknown-source" });
		expect(
			await runAgentHostSetup(["--codex", "--yes"], collision.runner),
		).toBe(1);
		expect(collision.calls.some((call) => call.interactive)).toBe(false);
	});

	it("reports readiness without claiming OAuth or a read", async () => {
		const lines: string[] = [];
		console.log = mock((line: string) => lines.push(line));
		const { calls, runner } = fakeRunner({
			codexInstalled: true,
			marketplaceSource: "/tmp/tedix",
		});
		expect(await runAgentHostSetup(["--codex", "--status"], runner)).toBe(0);
		expect(lines.join("\n")).toContain("OAuth not logged in");
		expect(lines.join("\n")).toContain(
			"MCP 2026-07-28 disabled; run codex features enable mcp_2026_07_28",
		);
		expect(lines.join("\n")).toContain("read: unverified");
		expect(calls.some((call) => call.interactive)).toBe(false);
	});

	it("reports modern protocol readiness without changing Codex settings", async () => {
		const lines: string[] = [];
		console.log = mock((line: string) => lines.push(line));
		const ready = fakeRunner({
			codexInstalled: true,
			codexModernProtocol: "true",
		});
		expect(await runAgentHostSetup(["--codex", "--status"], ready.runner)).toBe(
			0,
		);
		expect(lines.join("\n")).toContain("MCP 2026-07-28 enabled");
		expect(ready.calls.some((call) => call.interactive)).toBe(false);

		lines.length = 0;
		const unknown = fakeRunner({
			codexInstalled: true,
			codexModernProtocol: "unavailable",
		});
		expect(
			await runAgentHostSetup(["--codex", "--status"], unknown.runner),
		).toBe(0);
		expect(lines.join("\n")).toContain("MCP 2026-07-28 unverified");
	});

	it("updates a Git marketplace and a local source without switching either", async () => {
		const lines: string[] = [];
		console.log = mock((line: string) => lines.push(line));
		const git = fakeRunner({
			codexInstalled: true,
			marketplaceSource: "tedix-hq/tedix",
			claudeInstalled: true,
			claudeMarketplaceSource: "github",
		});
		expect(
			await runAgentHostSetup(["--all", "--update", "--yes"], git.runner),
		).toBe(0);
		expect(
			git.calls
				.filter((call) => call.interactive)
				.map((call) => `${call.command} ${call.args.join(" ")}`),
		).toEqual([
			"codex plugin marketplace upgrade tedix-repo",
			"codex plugin add tedix@tedix-repo",
			"claude plugin marketplace update tedix",
			"claude plugin update tedix@tedix",
		]);
		expect(lines.join("\n")).toContain("codex: Tedix plugin updated to v0.1.2");
		expect(lines.join("\n")).toContain(
			"claude: Tedix plugin updated to v0.1.2",
		);
		const local = fakeRunner({
			codexInstalled: true,
			marketplaceSource: "/tmp/tedix",
		});
		expect(
			await runAgentHostSetup(
				["--codex", "--update", "--dry-run"],
				local.runner,
			),
		).toBe(0);
		expect(local.calls.some((call) => call.interactive)).toBe(false);
	});

	it("reports a no-op host update without claiming the plugin changed", async () => {
		const lines: string[] = [];
		console.log = mock((line: string) => lines.push(line));
		const { runner } = fakeRunner({
			claudeInstalled: true,
			claudeMarketplaceSource: "github",
			versionAfterUpdate: "0.1.1",
		});
		expect(
			await runAgentHostSetup(["--claude", "--update", "--yes"], runner),
		).toBe(0);
		expect(lines.join("\n")).toContain(
			"still at v0.1.1; host reported no version change",
		);
	});

	it("dry run prints the plan without installing", async () => {
		console.log = mock(() => {});
		const { calls, runner } = fakeRunner({});
		expect(await runAgentHostSetup(["--all", "--dry-run"], runner)).toBe(0);
		expect(calls.some((call) => call.interactive)).toBe(false);
	});

	it("reports a specifically requested host that is not installed", async () => {
		console.log = mock(() => {});
		console.error = mock(() => {});
		const { calls, runner } = fakeRunner({ unavailable: "claude" });
		expect(await runAgentHostSetup(["--claude", "--yes"], runner)).toBe(1);
		expect(calls.some((call) => call.interactive)).toBe(false);
	});
});
