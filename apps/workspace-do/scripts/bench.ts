#!/usr/bin/env bun
/**
 * Time one question against a live workspace object through the MCP gateway.
 *
 *   TEDIX_BEARER=<token> bun apps/workspace-do/scripts/bench.ts \
 *     --mcp https://tedix.<mcp-host>/mcp --workspace <workspaceId> \
 *     --question "Read-only check: ..."
 *
 * Prints time to first streamed text, total time, steps, and the answer. The
 * token is any bearer the gateway accepts for the organization that owns the
 * workspace (for example the one `tedix -w connect` holds).
 */

function arg(name: string, fallback?: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value && fallback === undefined) {
		console.error(`missing --${name}`);
		process.exit(2);
	}
	return value ?? fallback ?? "";
}

const mcp = arg("mcp").replace(/\/$/, "");
const workspaceId = arg("workspace");
const question = arg(
	"question",
	"Read-only check: how many challenges excluding the problem-statement row, the three tied priorities, open Work items",
);
const bearer = process.env.TEDIX_BEARER;
if (!bearer) {
	console.error("TEDIX_BEARER is required");
	process.exit(2);
}

let id = 0;
async function call(name: string, args: Record<string, unknown>) {
	const response = await fetch(
		`${mcp}/workspaces/${encodeURIComponent(workspaceId)}`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${bearer}`,
				accept: "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++id,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		},
	);
	if (!response.ok)
		throw new Error(
			`${name}: HTTP ${response.status} ${await response.text()}`,
		);
	const body = (await response.json()) as {
		result?: { content: Array<{ text: string }>; isError?: boolean };
		error?: { message: string };
	};
	if (body.error) throw new Error(`${name}: ${body.error.message}`);
	const text = body.result?.content[0]?.text ?? "";
	if (body.result?.isError) throw new Error(`${name}: ${text}`);
	return JSON.parse(text) as Record<string, unknown>;
}

const sentAt = Date.now();
const started = await call("send_turn", { text: question, waitSeconds: 0 });
const turnId = String(started.turnId);
let outcome: Record<string, unknown> = started;
while (outcome.status === "running") {
	outcome = await call("read_turn", { turnId });
	if (outcome.status === "running")
		await new Promise((r) => setTimeout(r, 500));
	if (Date.now() - sentAt > 120_000) break;
}
const finishedAt = Date.now();
const events = (await call("read_events", {
	afterSeq: 0,
	limit: 5000,
})) as Array<{
	turnId: string;
	type: string;
	at: string;
	data: Record<string, unknown>;
}>;
const mine = events.filter((event) => event.turnId === turnId);
const startedEvent = mine.find((event) => event.type === "turn_started");
const firstText = mine.find((event) => event.type === "text_delta");
const finished = mine.find((event) => event.type === "turn_finished");
const t0 = startedEvent ? Date.parse(startedEvent.at) : sentAt;

console.log(
	JSON.stringify(
		{
			workspaceId,
			turnId,
			status: outcome.status,
			firstTokenMs: firstText ? Date.parse(firstText.at) - t0 : null,
			totalMs: finished ? Date.parse(finished.at) - t0 : finishedAt - sentAt,
			steps: finished?.data.steps ?? null,
			codeRuns: mine.filter((event) => event.type === "code_finished").length,
			changeRecords: mine.filter((event) => event.type === "change_recorded")
				.length,
			answer: outcome.text ?? outcome.error ?? null,
		},
		null,
		2,
	),
);
