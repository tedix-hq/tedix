import { parseArgs } from "node:util";

const gatewayNeedle =
	"mcp_grant_timing|resolveSessionAuth|recordVerifiedMcpExecution|recordPolicyToolApproval|/audit/createEvent|/audit/createTelemetryBatch";

export function buildQuery(args: string[], now = Date.now()) {
	const { values } = parseArgs({
		args: args[0] === "--" ? args.slice(1) : args,
		options: {
			service: { type: "string" },
			needle: { type: "string" },
			trace: { type: "string" },
			since: { type: "string", default: "20m" },
			until: { type: "string" },
			limit: { type: "string", default: "100" },
			gateway: { type: "boolean" },
		},
	});
	const duration = /^(\d+)(s|m|h|d)$/.exec(values.since!);
	const to = values.until ? Date.parse(values.until) : now;
	const from = duration
		? to -
			Number(duration[1]) *
				{ s: 1000, m: 60000, h: 3600000, d: 86400000 }[duration[2]!]!
		: Date.parse(values.since!);
	const limit = Number(values.limit);
	if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to)
		throw new Error(
			"Use --since 20m or an ISO timestamp before --until (default: now).",
		);
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
		throw new Error("--limit must be an integer from 1 to 1000.");
	if (values.gateway && values.needle)
		throw new Error("Choose --gateway or --needle.");
	const filters = [];
	for (const [key, value] of [
		["$metadata.service", values.service],
		["$metadata.traceId", values.trace],
	] as const) {
		if (value) filters.push({ key, value, operation: "eq", type: "string" });
	}
	return {
		queryId: "local-worker-logs",
		view: "events",
		preview: true,
		limit,
		timeframe: { from, to },
		parameters: {
			datasets: ["cloudflare-workers"],
			filters,
			...(values.needle || values.gateway
				? {
						needle: {
							value: values.gateway ? gatewayNeedle : values.needle,
							isRegex: !!values.gateway,
						},
					}
				: {}),
		},
	};
}

type LogEvent = {
	timestamp: number;
	source?: Record<string, unknown>;
	$metadata?: { service?: string; traceId?: string; requestId?: string };
	$workers?: { wallTimeMs?: number; cpuTimeMs?: number };
};

export function compactRow(event: LogEvent) {
	const source = event.source ?? {};
	const timing = Object.fromEntries(
		Object.entries(source).filter(
			([key, value]) => typeof value === "number" && /(?:Ms|_ms)$/.test(key),
		),
	);
	return JSON.stringify({
		time: new Date(event.timestamp).toISOString(),
		service: event.$metadata?.service,
		trace: event.$metadata?.traceId,
		request: event.$metadata?.requestId,
		event: source.event ?? source._tr ?? source.eventType,
		level: source.level,
		outcome: source.outcome,
		message:
			typeof source.message === "string"
				? source.message.replace(/\x1b\[[0-9;]*m/g, "")
				: undefined,
		tool: source.toolName ?? source.tool,
		...timing,
		wallTimeMs: event.$workers?.wallTimeMs,
		cpuTimeMs: event.$workers?.cpuTimeMs,
	});
}

if (import.meta.main) {
	try {
		const query = buildQuery(Bun.argv.slice(2));
		const child = Bun.spawn(
			["cf", "o11y", "telemetry", "query", "--body", JSON.stringify(query)],
			{
				stdout: "pipe",
				stderr: "inherit",
				env: process.env,
			},
		);
		const output = await new Response(child.stdout).text();
		if ((await child.exited) !== 0)
			throw new Error(
				"cf telemetry query failed; check the existing cf login and account selection.",
			);
		const result = JSON.parse(output);
		if (
			result.run?.status !== "COMPLETED" ||
			!Array.isArray(result.events?.events)
		)
			throw new Error("cf did not return a completed events query.");
		for (const event of result.events.events) console.log(compactRow(event));
		console.error(
			`${result.events.events.length} events; ${new Date(query.timeframe.from).toISOString()} to ${new Date(query.timeframe.to).toISOString()}`,
		);
		if (result.events.events.length >= query.limit)
			console.error(
				"Limit reached; narrow the window or raise --limit (max 1000). Results may be incomplete.",
			);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
