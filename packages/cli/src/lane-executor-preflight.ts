import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { laneChildEnv } from "./lane-child-env";
import { laneCommand } from "./lane-command";
import type { LocalExecutor } from "./lane-routing";

const PREFLIGHT_TIMEOUT_MS = 35_000;
const PREFLIGHT_CACHE_MS = 5 * 60_000;
const PREFLIGHT_RETRY_MS = 30_000;

type PreflightExecutor = Extract<LocalExecutor, "codex" | "claude-code">;
type Probe = (
	executor: PreflightExecutor,
	cwd: string,
) => Promise<string | undefined>;

const exitReason = (code: number | null, signal: string | null) =>
	signal ? `stopped by ${signal}` : `exited with code ${code}`;
const diagnostic = (value: unknown) =>
	typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, 160)
		: "";

async function codexPreflight(cwd: string) {
	const report = await laneCommand(
		"codex",
		["doctor", "--network-only", "--json"],
		{
			cwd,
			env: laneChildEnv(),
			timeout: PREFLIGHT_TIMEOUT_MS,
			killSignal: "SIGKILL",
		},
	);
	if (report.error?.code === "ETIMEDOUT") return "Codex Doctor timed out";
	if (report.error?.code)
		return `Codex Doctor could not run (${report.error.code})`;

	let data: unknown;
	try {
		data = JSON.parse(report.stdout);
	} catch {}
	if (isRecord(data) && (isRecord(data.checks) || Array.isArray(data.checks))) {
		const failed = Object.values(data.checks).find(
			(check) => isRecord(check) && check.status === "fail",
		);
		if (isRecord(failed)) {
			const detail = [diagnostic(failed.id), diagnostic(failed.summary)]
				.filter(Boolean)
				.join(": ");
			return detail || "A Codex network check failed";
		}
		if (report.status === 0) {
			if (data.overallStatus === "ok" || data.overallStatus === "warning")
				return;
			return `Codex Doctor reported ${diagnostic(data.overallStatus) || "an unknown health status"}`;
		}
	}
	return report.status === 0
		? "Codex Doctor did not return a valid network report"
		: `Codex Doctor ${exitReason(report.status, report.signal)}`;
}

function claudeInitFailure(event: Record<string, unknown>) {
	for (const [field, kind, name] of [
		["plugin_errors", "a plugin error", "plugin"],
		["mcp_server_errors", "an MCP configuration error", "name"],
	] as const) {
		const errors = event[field];
		if (Array.isArray(errors) && errors.length) {
			const error = errors[0];
			const detail =
				isRecord(error) &&
				[diagnostic(error[name]), diagnostic(error.type)]
					.filter(Boolean)
					.join(": ");
			return `Claude reported ${kind}${detail ? ` (${detail})` : ""}`;
		}
	}
	if (!Array.isArray(event.mcp_servers))
		return "Claude init did not report MCP status";
	for (const server of event.mcp_servers) {
		if (
			isRecord(server) &&
			["failed", "needs-auth"].includes(String(server.status))
		)
			return `Claude MCP server ${diagnostic(server.name) || "(unnamed)"}: ${server.status}`;
	}
}

function claudePreflight(cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		// Claude emits system/init at the start of a turn. Use a loopback model
		// endpoint so the synthetic prompt cannot reach a provider before we stop.
		const child = spawn(
			"claude",
			[
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--no-session-persistence",
				"Tedix executor pre-flight",
			],
			{
				cwd,
				env: {
					...laneChildEnv(),
					ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
					ANTHROPIC_AUTH_TOKEN: "tedix-preflight",
					ANTHROPIC_API_KEY: "tedix-preflight",
					NO_PROXY: [process.env.NO_PROXY, "127.0.0.1"]
						.filter(Boolean)
						.join(","),
					CLAUDE_CODE_USE_BEDROCK: "0",
					CLAUDE_CODE_USE_VERTEX: "0",
					CLAUDE_CODE_USE_FOUNDRY: "0",
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		const lines = createInterface({ input: child.stdout });
		let result: { reason?: string } | undefined;
		let kill: ReturnType<typeof setTimeout> | undefined;
		const finish = (reason?: string) => {
			if (result) return;
			result = { reason };
			child.kill();
			kill = setTimeout(() => child.kill("SIGKILL"), 2_000);
		};
		const timeout = setTimeout(
			() => finish("Claude init timed out"),
			PREFLIGHT_TIMEOUT_MS,
		);
		lines.on("line", (line) => {
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (
				isRecord(event) &&
				event.type === "system" &&
				event.subtype === "init"
			)
				finish(claudeInitFailure(event));
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			result ??= {
				reason: `Claude init could not run (${error.code ?? "spawn error"})`,
			};
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			clearTimeout(kill);
			lines.close();
			resolve(
				result
					? result.reason
					: `Claude ${exitReason(code, signal)} before reporting init`,
			);
		});
	});
}

export function cachedExecutorPreflight(
	cwd: string,
	onFailure: (executor: PreflightExecutor, reason: string) => void,
	probe: Probe = (executor, cwd) =>
		executor === "codex" ? codexPreflight(cwd) : claudePreflight(cwd),
) {
	const cache = new Map<
		PreflightExecutor,
		{
			nextAt: number;
			failures: number;
			reason?: string;
		}
	>();
	const pending = new Map<PreflightExecutor, Promise<string | undefined>>();
	return async (executor: LocalExecutor) => {
		if (executor !== "codex" && executor !== "claude-code") return;
		const prior = cache.get(executor);
		if (prior && Date.now() < prior.nextAt) return prior.reason;
		const running = pending.get(executor);
		if (running) return running;
		const checked = Promise.resolve()
			.then(() => probe(executor, cwd))
			.catch(() => "Could not run executor pre-flight")
			.then((reason) => {
				const failures = reason ? (prior?.failures ?? 0) + 1 : 0;
				const delay = failures
					? Math.min(
							PREFLIGHT_CACHE_MS,
							PREFLIGHT_RETRY_MS * 2 ** Math.min(failures - 1, 4),
						)
					: PREFLIGHT_CACHE_MS;
				cache.set(executor, { nextAt: Date.now() + delay, failures, reason });
				if (reason && failures === 1) onFailure(executor, reason);
				return reason;
			})
			.finally(() => pending.delete(executor));
		pending.set(executor, checked);
		return checked;
	};
}
