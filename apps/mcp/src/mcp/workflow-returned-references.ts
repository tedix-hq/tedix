import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import type { ToolExecutionContext } from "./handler";
import { readToolConfigExtension } from "./tool-config-extensions";
import { collectReturnedOpaqueValues } from "./utils/secret-egress-scan";

type ReferenceContext = Pick<
	ToolExecutionContext<ToolConfig>,
	"app" | "config"
> &
	Partial<Pick<ToolExecutionContext<ToolConfig>, "env" | "callerIdentity">>;

async function referenceScope(ctx: ReferenceContext): Promise<string | null> {
	const caller = ctx.callerIdentity;
	if (
		!ctx.env?.AGGREGATE_CACHE ||
		!ctx.app.organizationId ||
		!caller?.skillRunId ||
		!caller.workflowCallId ||
		caller.workflowExecutionEpoch === undefined
	)
		return null;
	// These identities come from the authenticated service-binding rewrite,
	// never arguments or request metadata. Calls in another run or namespace
	// cannot borrow an exemption, even when they know the reference itself.
	return sha256Hex(
		JSON.stringify([
			ctx.app.organizationId,
			caller.tediId,
			caller.skillRunId,
			caller.workflowExecutionEpoch,
			ctx.app.id,
			readToolConfigExtension(ctx.config, "_aggregateNamespace") ?? null,
		]),
	);
}

async function referenceKey(scope: string, value: string): Promise<string> {
	return `workflow-returned-references/v1/${scope}/${await sha256Hex(value)}`;
}

export async function readWorkflowReturnedReferences(
	input: unknown,
	ctx: ReferenceContext,
): Promise<ReadonlySet<string> | undefined> {
	const scope = await referenceScope(ctx);
	if (!scope) return undefined;
	const candidates = new Set<string>();
	collectReturnedOpaqueValues(input, candidates);
	if (!candidates.size) return undefined;
	const returned = new Set<string>();
	for (const value of candidates) {
		try {
			if (await ctx.env!.AGGREGATE_CACHE.head(await referenceKey(scope, value)))
				returned.add(value);
		} catch {
			// An unavailable provenance record must never weaken the scan.
		}
	}
	return returned;
}

export async function recordWorkflowReturnedReferences(
	result: unknown,
	ctx: ReferenceContext,
): Promise<void> {
	const scope = await referenceScope(ctx);
	if (!scope) return;
	const returned = new Set<string>();
	collectReturnedOpaqueValues(result, returned);
	// Independent immutable markers preserve concurrent tool results. Only
	// hashes are stored; provider-shaped secrets are excluded by the collector.
	for (const value of returned)
		await ctx.env!.AGGREGATE_CACHE.put(await referenceKey(scope, value), "1");
}
