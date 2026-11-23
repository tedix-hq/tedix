import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";
import { createTelemetryWriter } from "@tedix/worker-kit/telemetry";
import { contentFreeMcpException, createMcpLogger } from "./log";

const log = createMcpLogger("mcp.tool_counts");
const writeCount = createTelemetryWriter("mcp.tool_counts");
const COUNTER_PREFIX = "tool-count:";

export function toolCallCountStub(env: CloudflareEnv, day: string) {
	return durableObjectStubByName(
		env.MCP_SUBSCRIPTIONS,
		env,
		`tool-call-counts:v1:${day}`,
	);
}

/** Count attempts, including failed calls, without storing arguments or identity. */
export function countToolCall(
	env: CloudflareEnv,
	ctx: Pick<ExecutionContext, "waitUntil">,
	toolName: string,
): void {
	const day = new Date().toISOString().slice(0, 10);
	writeCount(async () => {
		try {
			const response = await toolCallCountStub(env, day).fetch(
				"https://tool-counts.internal/tool-counts/increment",
				{ method: "POST", body: JSON.stringify({ toolName }) },
			);
			if (!response.ok) throw new Error(`Counter status ${response.status}`);
		} catch (error) {
			// Counting must not turn a successful provider action into a retry.
			log.error("Tool call counter unavailable", {
				event: "mcp.tool_counts.failed",
				resourceKey: day,
				error: contentFreeMcpException(error),
			});
		}
	}, ctx.waitUntil.bind(ctx));
}

/** Only reached through the internal Durable Object binding, on dedicated day objects. */
export async function handleToolCallCounts(
	request: Request,
	storage: DurableObjectStorage,
): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path === "/tool-counts/increment") {
		const { toolName } = (await request.json()) as { toolName?: unknown };
		if (typeof toolName !== "string" || !toolName || toolName.length > 1024)
			return Response.json({ error: "Invalid tool name" }, { status: 400 });
		const key = `${COUNTER_PREFIX}${toolName}`;
		// Synchronous KV operations share SQLite's implicit atomic transaction.
		const count = storage.kv.get<number>(key) ?? 0;
		storage.kv.put(key, count + 1);
		return Response.json({ ok: true });
	}
	if (path === "/tool-counts/report") {
		const rows = [...storage.kv.list<number>({ prefix: COUNTER_PREFIX })].map(
			([key, calls]) => ({ toolName: key.slice(COUNTER_PREFIX.length), calls }),
		);
		rows.sort((a, b) => a.toolName.localeCompare(b.toolName));
		return Response.json({
			storage: "durable-object-sqlite",
			counterCount: rows.length,
			databaseBytes: storage.sql.databaseSize,
			rows,
		});
	}
	return Response.json({ error: "Unknown counter route" }, { status: 404 });
}
