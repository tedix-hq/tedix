import { TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
/**
 * `tedix tedi <slug|id> …` verb: direct tedi ask + durable Code Mode
 * commands through the selected organization gateway.
 */

import { type CommandContext, firstWord, reportSendResult } from "./commands";
import { normalizeCodeResult } from "./code-result";
import { printUnknownPayload } from "./format";
import type { TedixHomeClient } from "./home-client";
import { type AuthResolution, type CliOptions, looksLikeUuid } from "./shared";

export function tediUsage(): string {
	return `Tedix tedi commands

Use a worker slug or UUID in the selected organization:
  tedix tedi <slug|id> ask "<message>"  Route a durable Home delegation
  tedix tedi <slug|id> code "<js>"     Run durable code on that worker
  tedix tedi <slug|id> export <path>    Create a full-history portable Git bundle
  tedix tedi <new-slug> import <path>   Restore a bundle into a paused tedi

Per-tedi durable Code Mode is not the org gateway's stateless Code Mode. Inside
the tedi runtime use its native mcp.* provider (for example mcp.search_tools()).
For the org-wide gateway use tedix code with discover.search() and exact
namespaced calls.

All worker commands use the selected organization (--organization <slug|id>).
Read executions: Tedis read. Run code: Tedis write. Approve, reject, or roll
back: Tedis admin and a verified human operator. Machines cannot approve code.

Durable Code Mode lifecycle:
  tedix tedi <slug|id> executions
  tedix tedi <slug|id> execution <executionId>
  tedix tedi <slug|id> approve-code <executionId>
  tedix tedi <slug|id> reject-code <executionId> <seq>
  tedix tedi <slug|id> rollback-code <executionId>
  tedix tedi <slug|id> recover-code <executionId>
`;
}

async function resolveDelegationTediId(
	target: string,
	client: TedixHomeClient,
): Promise<string> {
	if (
		!looksLikeUuid(target) &&
		!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target)
	) {
		throw new Error(`Invalid tedi slug: ${target}`);
	}
	const resolved = normalizeCodeResult(
		await client.runCode(
			looksLikeUuid(target)
				? `async () => (await tedis.get_tedi({ tediId: ${JSON.stringify(target)} })).id ?? null`
				: `async () => {
  const target = ${JSON.stringify(target)};
  let offset = 0;
  while (true) {
    const result = await tedis.list_tedis({ search: target, limit: 100, offset });
    if (!Array.isArray(result.data)) throw new Error("Could not load workers in the selected organization");
    const match = result.data.find(tedi => tedi.slug === target);
    if (match) return match.id;
    if (!result.pagination?.hasMore) return null;
    offset += 100;
  }
}`,
		),
	).value;
	if (typeof resolved !== "string" || !looksLikeUuid(resolved)) {
		throw new Error(`Tedi not found in the selected organization: ${target}`);
	}
	return resolved;
}

export async function runTediCommand(
	args: string | undefined,
	ctx: CommandContext,
	options: CliOptions,
	_auth: AuthResolution,
): Promise<number> {
	const [target, rest] = firstWord(args ?? "");
	const [subcommand, tail] = firstWord(rest);
	if (!target || !subcommand) {
		throw new Error(tediUsage());
	}
	if (subcommand === "export") {
		if (!tail.trim()) {
			throw new Error("Usage: tedix tedi <slug|id> export <output.bundle>");
		}
		const tediId = await resolveDelegationTediId(target, ctx.client);
		const { exportPortableTedi, gatewayPortableTediSource } =
			await import("./portable-tedi");
		const result = await exportPortableTedi({
			tediId,
			outputPath: tail.trim(),
			source: gatewayPortableTediSource(ctx.client),
		});
		printUnknownPayload(result, options.json);
		return 0;
	}
	if (subcommand === "import") {
		if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(target)) {
			throw new Error(`Invalid destination tedi slug: ${target}`);
		}
		if (!tail.trim()) {
			throw new Error("Usage: tedix tedi <new-slug> import <input.bundle>");
		}
		const { importPortableTedi, gatewayPortableTediDestination } =
			await import("./portable-tedi");
		const result = await importPortableTedi({
			bundlePath: tail.trim(),
			destinationSlug: target,
			destination: gatewayPortableTediDestination(ctx.client),
		});
		printUnknownPayload(result, options.json);
		return 0;
	}
	if (subcommand !== "ask") {
		const tools: Record<string, string> = {
			code: "run_tedi_durable_code",
			executions: "list_tedi_code_executions",
			execution: "get_tedi_code_execution",
			"approve-code": "approve_tedi_code_execution",
			"reject-code": "reject_tedi_code_execution",
			"rollback-code": "rollback_tedi_code_execution",
			"recover-code": "recover_tedi_code_execution",
		};
		const tool = tools[subcommand];
		if (!tool) throw new Error(`Unknown tedi subcommand: ${subcommand}`);
		const input: Record<string, unknown> = {};
		if (subcommand === "code") {
			if (!tail) throw new Error('Usage: tedix tedi <slug|id> code "<js>"');
			input.code = tail;
		} else if (subcommand === "executions") {
			input.limit = options.limit ?? 20;
		} else {
			const [executionId, remaining] = firstWord(tail);
			if (!executionId) throw new Error(`${subcommand} requires executionId`);
			input.executionId = executionId;
			if (subcommand === "recover-code" && remaining)
				throw new Error("recover-code accepts only executionId");
			if (subcommand === "reject-code") {
				const sequence = firstWord(remaining)[0];
				const seq = /^\d+$/.test(sequence) ? Number(sequence) : NaN;
				if (!Number.isSafeInteger(seq) || seq < 0) {
					throw new Error("reject-code requires a non-negative pending seq");
				}
				input.seq = seq;
			}
		}
		// The existing resource-bound gateway authenticates the whole call. A
		// Connect token must never be replayed against a different worker host.
		input.tediId = await resolveDelegationTediId(target, ctx.client);
		const source = `async () => await tedis.${tool}(${JSON.stringify(input)})`;
		const raw = ["code", "approve-code", "rollback-code"].includes(subcommand)
			? await ctx.client.callTool(
					"code",
					{ code: source },
					{
						retryable: false,
						signal: AbortSignal.timeout(TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS),
					},
				)
			: await ctx.client.runCode(source);
		const result = normalizeCodeResult(raw);
		if (result.truncated)
			throw new Error("Worker result was truncated; request fewer executions");
		printUnknownPayload(result.value, options.json);
		if (subcommand === "recover-code")
			return result.value &&
				typeof result.value === "object" &&
				"recovered" in result.value &&
				result.value.recovered === true
				? 0
				: 2;
		return result.value &&
			typeof result.value === "object" &&
			"status" in result.value &&
			result.value.status === "error"
			? 2
			: 0;
	}
	if (!tail) throw new Error('Usage: tedix tedi <slug|tedi-id> ask "message"');
	const previousDelegate = options.delegateToTediId;
	options.delegateToTediId = await resolveDelegationTediId(target, ctx.client);
	try {
		return reportSendResult(await ctx.ops.send(tail), ctx);
	} finally {
		options.delegateToTediId = previousDelegate;
	}
}
