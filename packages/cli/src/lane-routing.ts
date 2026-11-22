import * as z from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const localExecutors = [
	"codex",
	"claude-code",
	"opencode",
	"devin",
] as const;
export type LocalExecutor = (typeof localExecutors)[number];
const executorSchema = z.enum(localExecutors);
export const routingPolicySchema = z.strictObject({
	version: z.literal(1),
	nearLimitPercent: z.number().min(0).max(100),
	signalMaxAgeMs: z.number().positive(),
	rules: z
		.array(
			z.strictObject({
				name: z.string().min(1),
				/** Why this rule exists, in the owner's words; shown with the rule. */
				description: z.string().max(300).optional(),
				tags: z.array(z.string()),
				sizes: z.array(z.string()),
				risks: z.array(z.string()),
				routes: z.array(
					z.strictObject({
						executor: executorSchema,
						model: z.string().min(1).optional(),
					}),
				),
			}),
		)
		.min(1),
	budgetFiles: z.partialRecord(executorSchema, z.array(z.string())),
	opencodeModel: z
		.string()
		.regex(/^[^/\s]+\/[^\s]+$/)
		.optional(),
});
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;
export const defaultRoutingPolicy: RoutingPolicy = {
	version: 1,
	nearLimitPercent: 10,
	signalMaxAgeMs: 300_000,
	rules: [{ name: "unconfigured", tags: [], sizes: [], risks: [], routes: [] }],
	budgetFiles: {},
};
export function readRoutingPolicy(
	path?: string,
	env = process.env,
): RoutingPolicy {
	const policy = path
		? routingPolicySchema.parse(JSON.parse(readFileSync(path, "utf8")))
		: structuredClone(defaultRoutingPolicy);
	const modelPath =
		env.OPENCODE_ROUTING_CONFIG ??
		(env.TEDIX_LANE_LOG
			? join(dirname(env.TEDIX_LANE_LOG), "opencode-routing.json")
			: undefined);
	if (!path && modelPath && existsSync(modelPath)) {
		const config = JSON.parse(readFileSync(modelPath, "utf8"));
		policy.opencodeModel = z
			.string()
			.regex(/^[^/\s]+\/[^\s]+$/)
			.parse(
				typeof config === "string"
					? config
					: (config.defaultModel ?? config.model ?? config.default),
			);
	}
	return policy;
}
const AGENT_NAMES: Record<LocalExecutor, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	opencode: "OpenCode",
	devin: "Devin",
};

/** A kind of task in plain words, from what a routing rule matches. */
function taskKind(rule: {
	tags: string[];
	sizes: string[];
	risks: string[];
}): string {
	if (!rule.tags.length && !rule.sizes.length && !rule.risks.length)
		return "Everything else";
	if (rule.risks.length || rule.sizes.includes("large"))
		return "Large or risky tasks";
	if (
		rule.sizes.includes("small") ||
		rule.tags.some((tag) => ["mechanical", "formatting", "docs"].includes(tag))
	)
		return "Small routine tasks";
	return rule.tags.length
		? `Tasks about ${rule.tags.slice(0, 2).join(" or ")}`
		: "Other tasks";
}

/** The agents a rule tries, first choice first, in plain names. */
function agentChain(routes: RoutingPolicy["rules"][number]["routes"]): string {
	const names = routes.map((route) => AGENT_NAMES[route.executor]);
	return names.length ? names.join(", then ") : "no agent";
}

/**
 * The routing file in plain words, matching the desktop app's wording: one
 * summary line when every rule names the same agents, or a row per kind of
 * task when they differ. No rule names, tags, model ids or budget sentence
 * unless a budget file is configured.
 */
export function describeRoutingPolicy(policy: RoutingPolicy): string[] {
	const chains = policy.rules.map((rule) => agentChain(rule.routes));
	const lines: string[] = [];
	if (chains.every((chain) => chain === chains[0])) {
		lines.push(
			chains[0] === "no agent"
				? "Right now no agent takes tasks."
				: `Right now every task goes to ${chains[0]}.`,
		);
	} else {
		lines.push("Each kind of task goes to its own tool.");
		for (const [index, rule] of policy.rules.entries()) {
			const kind = taskKind(rule);
			const target = chains[index]!;
			lines.push(
				`${kind} ${kind === "Everything else" ? "goes" : "go"} to ${target === "no agent" ? "no agent yet" : target}.` +
					(rule.description ? ` ${rule.description}` : ""),
			);
		}
	}
	if (Object.values(policy.budgetFiles).some((files) => files.length > 0))
		lines.push(
			`An agent counts as out of budget at ${policy.nearLimitPercent}% or less of its allowance left.`,
		);
	return lines;
}

export interface BudgetSnapshot {
	observedAt: number;
	source: "native" | "error" | "unknown";
	remainingPercent?: number;
	resetAt?: number;
	estimatedCostUsd?: number;
	backoffUntil?: number;
	consecutiveLimits?: number;
}
export type ExecutorBudgets = Partial<Record<LocalExecutor, BudgetSnapshot>>;
export function parseBudgetSignal(
	signal: unknown,
	now = Date.now(),
): BudgetSnapshot {
	const snapshot: BudgetSnapshot = { observedAt: now, source: "unknown" };
	const record = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const root = record(signal);
	const limits = record(root.rate_limits ?? root.rateLimits ?? signal);
	const windows = [
		limits.primary,
		limits.secondary,
		limits.five_hour,
		limits.seven_day,
		limits,
	];
	for (const raw of windows) {
		const window = record(raw);
		const used = window.used_percent ?? window.utilization;
		const remaining =
			typeof window.remainingPercent === "number"
				? window.remainingPercent
				: typeof used === "number"
					? 100 - used
					: undefined;
		if (
			remaining !== undefined &&
			Number.isFinite(remaining) &&
			remaining >= 0 &&
			remaining <= 100
		) {
			snapshot.remainingPercent = Math.min(
				snapshot.remainingPercent ?? 100,
				remaining,
			);
			snapshot.source = "native";
			const reset = window.resets_at ?? window.resetAt;
			const at =
				typeof reset === "number"
					? reset * 1000
					: typeof reset === "string"
						? Date.parse(reset)
						: NaN;
			if (Number.isFinite(at))
				snapshot.resetAt = Math.max(snapshot.resetAt ?? 0, at);
		}
	}
	if (root.status === "rejected" || root.status === "allowed_warning") {
		snapshot.remainingPercent = root.status === "rejected" ? 0 : 10;
		snapshot.source = "native";
		if (typeof root.resetsAt === "number")
			snapshot.resetAt = root.resetsAt * 1000;
	}
	const used = root.sessions_used,
		cap = root.session_limit;
	if (
		typeof used === "number" &&
		typeof cap === "number" &&
		cap > 0 &&
		used >= 0
	) {
		snapshot.remainingPercent = Math.max(0, (100 * (cap - used)) / cap);
		snapshot.source = "native";
	}
	if (
		typeof root.estimatedCostUsd === "number" &&
		Number.isFinite(root.estimatedCostUsd) &&
		root.estimatedCostUsd >= 0
	) {
		snapshot.estimatedCostUsd = root.estimatedCostUsd;
		snapshot.source = "native";
	}
	return snapshot;
}
export function executorBackoff(
	message: string,
	previous?: BudgetSnapshot,
	now = Date.now(),
): BudgetSnapshot | undefined {
	if (
		!/\b429\b|rate.?limit|usage limit|quota exceeded|session limit|weekly limit|capacity exhausted/i.test(
			message,
		)
	)
		return;
	const consecutiveLimits = (previous?.consecutiveLimits ?? 0) + 1;
	const retry = message.match(/retry[- ]after[\s:=]+(\d+)/i);
	const retryMs = retry ? Number(retry[1]) * 1000 : 0;
	const duration = Math.max(
		Number.isFinite(new Date(now + retryMs).getTime()) ? retryMs : 0,
		Math.min(60 * 60_000, 60_000 * 2 ** Math.min(consecutiveLimits - 1, 6)),
	);
	return {
		...previous,
		source: "error",
		observedAt: now,
		consecutiveLimits,
		backoffUntil: Math.max(previous?.backoffUntil ?? 0, now + duration),
	};
}
export class LocalExecutorCapacityError extends Error {
	override name = "LocalExecutorCapacityError";
}

export class LocalExecutorPreflightError extends LocalExecutorCapacityError {}

export interface ExecutorAvailability {
	available: boolean;
	preflightFailed?: boolean;
	/** Why the route was rejected, e.g. a failed `--version` probe. */
	reason?: string;
	/**
	 * The probe could not answer in time, so the executor may well be fine.
	 * Routing waits and tries again instead of failing the Work.
	 */
	transient?: boolean;
	/** Set when the probe passed only on its longer second try. */
	slow?: string;
}

export function routeLocalWork(
	work: { executor: string; tags?: string[]; size?: string; risk?: string },
	policy: RoutingPolicy,
	available: Record<LocalExecutor, ExecutorAvailability>,
	budgets: ExecutorBudgets,
	now = Date.now(),
) {
	const rule =
		policy.rules.find(
			(row) =>
				row.tags.some((tag) => work.tags?.includes(tag)) ||
				row.sizes.includes(work.size ?? "") ||
				row.risks.includes(work.risk ?? ""),
		) ?? policy.rules[policy.rules.length - 1]!;
	const routes =
		work.executor === "any-local"
			? rule.routes
			: [
					rule.routes.find((route) => route.executor === work.executor) ?? {
						executor: executorSchema.parse(work.executor),
						model: policy.rules
							.flatMap((row) => row.routes)
							.find((route) => route.executor === work.executor)?.model,
					},
				];
	if (routes.length === 0)
		throw new Error(
			`No routes configured for ${rule.name}; use --routing-config or TEDIX_LANE_ROUTING_CONFIG to choose executors and models`,
		);
	let capacityPaused = false;
	let preflightPaused = false;
	const rejected: string[] = [];
	for (const route of routes) {
		const budget = budgets[route.executor];
		const fresh =
			budget &&
			(now - budget.observedAt <= policy.signalMaxAgeMs ||
				(budget.resetAt ?? 0) > now);
		const probe = available[route.executor];
		if (!probe?.available) {
			if (probe?.transient) capacityPaused = true;
			if (probe?.preflightFailed) preflightPaused = true;
			rejected.push(`${route.executor}: ${probe?.reason ?? "unavailable"}`);
			continue;
		}
		if ((budget?.backoffUntil ?? 0) > now) {
			capacityPaused = true;
			rejected.push(
				`${route.executor}: budget backoff until ${new Date(budget!.backoffUntil!).toISOString()}`,
			);
			continue;
		}
		// Codex's included allowance excludes backup credits; actual refusals use backoff.
		if (
			route.executor !== "codex" &&
			fresh &&
			(budget.resetAt === undefined || budget.resetAt > now) &&
			budget.remainingPercent !== undefined &&
			budget.remainingPercent <= policy.nearLimitPercent
		) {
			capacityPaused = true;
			rejected.push(
				`${route.executor}: ${budget.remainingPercent}% remaining is at or below the ${policy.nearLimitPercent}% near-limit` +
					(budget.resetAt !== undefined
						? ` until ${new Date(budget.resetAt).toISOString()}`
						: ""),
			);
			continue;
		}
		return {
			...route,
			/** Earlier tools in the rule that could not take it, and why. */
			skipped: rejected,
			model:
				route.executor === "opencode"
					? (policy.opencodeModel ??
						route.model ??
						rule.routes.find((r) => r.executor === "opencode")?.model)
					: route.model,
			rule: rule.name,
		};
	}
	const message =
		`No eligible local executor for ${rule.name}` +
		(rejected.length ? ` (${rejected.join("; ")})` : "") +
		"; assignments and capability requirements retained";
	if (preflightPaused) throw new LocalExecutorPreflightError(message);
	throw capacityPaused
		? new LocalExecutorCapacityError(message)
		: new Error(message);
}
export function isMissingNativeState(error: unknown) {
	return /(?:session|thread|rollout).*(?:not found|missing|does not exist|archived)|no (?:session|thread|rollout).*found/i.test(
		String(error),
	);
}
export async function resumeThenFresh<T>(
	resume: () => Promise<T>,
	fresh: () => Promise<T>,
): Promise<T> {
	try {
		return await resume();
	} catch (error) {
		if (!isMissingNativeState(error)) throw error;
		return fresh();
	}
}
