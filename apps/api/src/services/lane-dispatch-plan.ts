import type { LaneDispatchPlan } from "@tedix/api-contract/schemas/work-items";

export function initialLaneDispatch(
	executor: unknown,
): LaneDispatchPlan | undefined {
	return ["codex", "claude-code", "tedi", "human"].includes(String(executor))
		? { state: "ready" }
		: undefined;
}

export function mentionedExecutor(
	body: string,
	tedis: { id: string; name: string; slug: string }[],
) {
	const target = body.match(
		/\bdelegat(?:ed|ion)\s*(?:by\s+[^\n]+?\s+)?to\s+(?:the\s+)?([^\n.;]+)/i,
	)?.[1];
	if (!target) return undefined;
	if (/\b(Mac Lead|Codex)\b/i.test(target))
		return { executor: "codex" as const };
	if (/\bClaude(?: Code)?\b/i.test(target))
		return { executor: "claude-code" as const };
	const normalized = target.trim().toLowerCase();
	const tedi = tedis.find((t) =>
		[t.name, t.slug].some((n) => n.toLowerCase() === normalized),
	);
	return tedi ? { executor: "tedi" as const, tediId: tedi.id } : undefined;
}
