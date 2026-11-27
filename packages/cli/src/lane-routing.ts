import {
	effortSchema,
	permissionSchema,
	executionSettings,
} from "./lane-execution-settings";
import * as z from "zod";
import { laneLimitsSchema } from "./lane-limits";
import { DecisionModelSchema } from "@tedix/api-contract/schemas/jev";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const localExecutors = [
	"codex",
	"claude-code",
	"cursor",
	"opencode",
	"devin",
	"tedi",
] as const;
export type LocalExecutor = (typeof localExecutors)[number];
const executorSchema = z.enum(localExecutors);
export const tediSlugSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
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
					z
						.strictObject({
							executor: executorSchema,
							model: z.string().min(1).optional(),
							limits: laneLimitsSchema.optional(),
							effort: effortSchema.optional(),
							permission: permissionSchema.optional(),
						})
						.superRefine((route, context) => {
							try {
								executionSettings(route.executor, route);
							} catch (error) {
								context.addIssue({ code: "custom", message: String(error) });
							}
						}),
				),
			}),
		)
		.min(1),
	budgetFiles: z.partialRecord(executorSchema, z.array(z.string())),
	/**
	 * Who picks the tool for a task that is not kept on one: "clef" asks the
	 * Clef decision model among the tools available now, with the rules as
	 * the backup; "rules" uses the rules alone. Default "clef".
	 */
	decide: z.enum(["clef", "rules"]).optional(),
	/** Each tool's strengths in the owner's words, offered to Clef. */
	tools: z
		.partialRecord(
			executorSchema,
			z.strictObject({
				strengths: z.string().min(1).max(300),
				/** Titles of tasks this tool did well, shown to the decision model. */
				examples: z.array(z.string().min(1).max(200)).max(5).optional(),
				/** Never offered while it runs this many tasks on this Mac. */
				maxRunning: z.number().int().positive().optional(),
			}),
		)
		.optional(),
	/** The decision model: Clef (default: the organization's) or Jev. */
	decideModel: DecisionModelSchema.optional(),
	/**
	 * Below this probability for its pick (among the offered tools) the rules
	 * decide. Default 0.35; four tools at random would be 0.25 each.
	 */
	clefMinConfidence: z.number().min(0).max(1).optional(),
	opencodeModel: z
		.string()
		.regex(/^[^/\s]+\/[^\s]+$/)
		.optional(),
	tedi: tediSlugSchema.optional(),
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
	cursor: "Cursor",
	opencode: "OpenCode",
	devin: "Devin",
	tedi: "Tedi",
};

/** True when Clef picks the tool: switched on and at least two tools described. */
export function clefDecides(policy: RoutingPolicy): boolean {
	return (
		(policy.decide ?? "clef") === "clef" &&
		Object.keys(policy.tools ?? {}).length >= 2
	);
}

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
	const strengths = Object.entries(policy.tools ?? {});
	if (clefDecides(policy)) {
		lines.push(
			"Clef picks the tool for each task from the tools available now; the order below is the backup.",
		);
		for (const [executor, tool] of strengths)
			lines.push(
				`${AGENT_NAMES[executor as LocalExecutor]}: ${tool!.strengths}`,
			);
	} else if (policy.decide === "clef")
		lines.push(
			"Clef is chosen to pick the tool, but fewer than two tools have strengths written down, so the order below decides.",
		);
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

/** One reported limit or balance, in the tool's own words. */
export interface UsageWindow {
	/** Plain name, e.g. "Weekly", "5-hour", "Credits". */
	name: string;
	/** Share of the limit used, 0-100. */
	usedPercent?: number;
	/** Share left, 0-100, when the tool reports remaining instead. */
	remainingPercent?: number;
	/** When the window resets, epoch ms. */
	resetAt?: number;
	/** Extra plain detail, e.g. "79.85 left" or "9 of 10 sessions". */
	detail?: string;
}
export interface BudgetSnapshot {
	observedAt: number;
	source: "native" | "error" | "unknown";
	remainingPercent?: number;
	resetAt?: number;
	estimatedCostUsd?: number;
	backoffUntil?: number;
	backoffKind?: "preparation";
	consecutiveLimits?: number;
	/** The plan or credit source the tool reported, e.g. "pro" or "azure". */
	plan?: string;
	/** Each limit the tool itself reports, with its reset time. */
	windows?: UsageWindow[];
	/** Plain words on what the tool does or does not expose. */
	note?: string;
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
	const candidates = [
		limits.primary,
		limits.secondary,
		limits.five_hour,
		limits.seven_day,
		limits,
	];
	for (const raw of candidates) {
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
	const usage = usageWindows(limits, root);
	if (usage.plan) snapshot.plan = usage.plan;
	if (usage.windows.length) snapshot.windows = usage.windows;
	// A nested report (Claude's unifiedWindows, Codex's per-window entries)
	// still bounds the snapshot's remaining share for routing.
	const floor = usage.windows.reduce<number | undefined>(
		(best, window) =>
			window.usedPercent !== undefined
				? Math.min(best ?? 100, 100 - window.usedPercent)
				: best,
		undefined,
	);
	if (floor !== undefined) {
		snapshot.remainingPercent = Math.min(
			snapshot.remainingPercent ?? 100,
			floor,
		);
		snapshot.source = "native";
		const resets = usage.windows
			.map((window) => window.resetAt)
			.filter((at): at is number => at !== undefined);
		if (resets.length)
			snapshot.resetAt = Math.max(snapshot.resetAt ?? 0, ...resets);
	}
	return snapshot;
}

const CLAUDE_WINDOW_NAMES: Record<string, string> = {
	five_hour: "5-hour",
	seven_day: "Weekly",
	seven_day_opus: "Weekly Opus",
	seven_day_sonnet: "Weekly Sonnet",
	seven_day_overage_included: "Weekly extra usage",
	overage: "Extra usage",
};
const CODEX_WINDOW_NAMES: Record<number, string> = {
	300: "5-hour",
	10080: "Weekly",
	43200: "Monthly",
};
function epochMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value))
		return value > 1e12 ? value : value * 1000;
	if (typeof value === "string") {
		const at = Date.parse(value);
		return Number.isFinite(at) ? at : undefined;
	}
	return undefined;
}
/** Plan, credit source and each named window a tool reports for itself. */
function usageWindows(
	limits: Record<string, unknown>,
	root: Record<string, unknown>,
): { plan?: string; windows: UsageWindow[] } {
	const record = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const windows: UsageWindow[] = [];
	let plan: string | undefined;
	const planType = limits.plan_type ?? limits.planType;
	if (typeof planType === "string" && planType) plan = planType;
	const credits = record(limits.credits);
	if (credits.unlimited === true)
		plan = plan ? `${plan} · unlimited` : "Unlimited";
	else if (typeof credits.balance === "string" && credits.balance)
		windows.push({ name: "Credits", detail: `${credits.balance} left` });
	const limitName =
		typeof limits.limit_name === "string" && limits.limit_name
			? limits.limit_name
			: typeof limits.limit_id === "string" && limits.limit_id
				? limits.limit_id
				: undefined;
	for (const key of ["primary", "secondary"]) {
		const window = record(limits[key]);
		const used = window.used_percent;
		if (typeof used !== "number" || !Number.isFinite(used)) continue;
		const minutes =
			typeof window.window_minutes === "number"
				? window.window_minutes
				: undefined;
		const span = minutes
			? (CODEX_WINDOW_NAMES[minutes] ?? `${minutes} minutes`)
			: key;
		const entry: UsageWindow = {
			name: limitName ? `${limitName} ${span}` : span,
			usedPercent: Math.min(100, Math.max(0, used)),
			resetAt: epochMs(window.resets_at ?? window.resetAt),
		};
		windows.push(entry);
	}
	const unified = record(limits.unifiedWindows);
	for (const [key, name] of Object.entries(CLAUDE_WINDOW_NAMES)) {
		const window = record(unified[key]);
		const utilization = window.utilization;
		if (typeof utilization !== "number" || !Number.isFinite(utilization))
			continue;
		windows.push({
			name,
			usedPercent: Math.min(100, Math.max(0, utilization * 100)),
			resetAt: epochMs(window.resetsAt ?? window.reset_at),
		});
	}
	const type = limits.rateLimitType ?? limits.rate_limit_type;
	if (typeof type === "string" && type && !(type in unified)) {
		windows.push({
			name: CLAUDE_WINDOW_NAMES[type] ?? type.replaceAll("_", " "),
			usedPercent:
				root.status === "rejected"
					? 100
					: typeof limits.used_percent === "number"
						? limits.used_percent
						: undefined,
			resetAt: epochMs(limits.resetsAt ?? limits.reset_at),
		});
	}
	const used = root.sessions_used,
		cap = root.session_limit;
	if (
		typeof used === "number" &&
		typeof cap === "number" &&
		cap > 0 &&
		used >= 0
	)
		windows.push({
			name: "Sessions",
			usedPercent: Math.min(100, Math.max(0, (100 * used) / cap)),
			detail: `${used} of ${cap} sessions`,
		});
	return { plan, windows };
}
/** One plain line per tool: plan or credit source, each limit used and reset. */
export function describeUsage(snapshot: BudgetSnapshot | undefined): string {
	if (!snapshot) return "";
	const parts: string[] = [];
	if (snapshot.plan) parts.push(snapshot.plan);
	for (const window of snapshot.windows ?? []) {
		const name = window.name.charAt(0).toUpperCase() + window.name.slice(1);
		if (window.usedPercent !== undefined) {
			let text = `${name}: ${Math.round(window.usedPercent)}% used`;
			if (window.detail) text += ` (${window.detail})`;
			if (window.resetAt && window.resetAt > Date.now())
				text += `, resets ${new Date(window.resetAt).toLocaleString(undefined, {
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit",
				})}`;
			parts.push(text);
		} else if (window.detail) parts.push(`${name}: ${window.detail}`);
	}
	if (snapshot.estimatedCostUsd !== undefined)
		parts.push(`cost $${snapshot.estimatedCostUsd.toFixed(2)} today`);
	if (!parts.length && snapshot.note) return snapshot.note;
	const text = parts.join(" · ");
	return snapshot.note ? `${text} — ${snapshot.note}` : text;
}
/** True when any reported window is at or above ~90% used. */
export function nearUsageLimit(snapshot: BudgetSnapshot | undefined): boolean {
	return (snapshot?.windows ?? []).some(
		(window) => window.usedPercent !== undefined && window.usedPercent >= 90,
	);
}
export function executorBackoff(
	message: string,
	previous?: BudgetSnapshot,
	now = Date.now(),
	preparationFailed = false,
): BudgetSnapshot | undefined {
	if (
		!preparationFailed &&
		!/\b429\b|\b529\b|overloaded|rate.?limit|usage limit|usageLimitExceeded|limit reached|hit your limit|quota exceeded|insufficient_quota|resource_exhausted|session limit|weekly limit|capacity exhausted|purchase more credits|out of credits|credit balance is too low/i.test(
			message,
		)
	)
		return;
	const consecutiveLimits = (previous?.consecutiveLimits ?? 0) + 1;
	const retry = message.match(/retry[- ]after[\s:=]+(\d+)/i);
	const retryMs = retry ? Number(retry[1]) * 1000 : 0;
	// The tool's own reset time wins over the doubling guess, so a long
	// outage is not retried every hour, and the tool counts as back at once
	// when that time passes.
	const until = statedResetAt(message, now) ?? Number.NaN;
	const toolWait =
		Number.isFinite(until) && until > now && until - now < 8 * 86_400_000
			? until - now
			: 0;
	const duration = Math.max(
		Number.isFinite(new Date(now + retryMs).getTime()) ? retryMs : 0,
		toolWait,
		Math.min(60 * 60_000, 60_000 * 2 ** Math.min(consecutiveLimits - 1, 6)),
	);
	return {
		...previous,
		source: "error",
		observedAt: now,
		consecutiveLimits,
		backoffKind: preparationFailed ? "preparation" : undefined,
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

/** The first rule a task matches; the last rule takes everything else. */
export function ruleFor(
	work: { tags?: string[]; size?: string; risk?: string },
	policy: RoutingPolicy,
) {
	return (
		policy.rules.find(
			(row) =>
				row.tags.some((tag) => work.tags?.includes(tag)) ||
				row.sizes.includes(work.size ?? "") ||
				row.risks.includes(work.risk ?? ""),
		) ?? policy.rules[policy.rules.length - 1]!
	);
}

/**
 * When a tool says it works again, read from its own limit message, as a
 * time. Codex: "try again at Nov 23rd, 2026 12:18 AM". Claude Code: "usage
 * limit reached|1732321080" or "resets 9pm" / "resets at 3:30 AM". Any tool:
 * "resets at <ISO time>". Clock times are this Mac's local time; a time
 * already past today means tomorrow.
 */
export function statedResetAt(
	message: string,
	now = Date.now(),
): number | undefined {
	const codex = message.match(
		/try again (?:at|after) ([A-Z][a-z]{2,8} \d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? (\d{1,2}:\d{2}(?: ?[AP]M)?)/,
	);
	if (codex) {
		const at = Date.parse(`${codex[1]}, ${codex[2]} ${codex[3]}`);
		if (Number.isFinite(at)) return at;
	}
	const epoch = message.match(/limit reached\|(\d{10})\b/i);
	if (epoch) return Number(epoch[1]) * 1000;
	const iso = message.match(
		/\bresets?(?: at)? (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i,
	);
	if (iso && Number.isFinite(Date.parse(iso[1]!))) return Date.parse(iso[1]!);
	const clock = message.match(
		/\bresets?(?: at)? (\d{1,2})(?::(\d{2}))? ?([ap])\.?m\b/i,
	);
	if (clock) {
		const hour =
			(Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === "p" ? 12 : 0);
		const at = new Date(now);
		at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
		if (at.getTime() <= now) at.setDate(at.getDate() + 1);
		return at.getTime();
	}
}

export function routeLocalWork(
	work: { executor: string; tags?: string[]; size?: string; risk?: string },
	policy: RoutingPolicy,
	available: Record<LocalExecutor, ExecutorAvailability>,
	budgets: ExecutorBudgets,
	now = Date.now(),
) {
	const rule = ruleFor(work, policy);
	const routes =
		work.executor === "any-local"
			? rule.routes
			: [
					rule.routes.find((route) => route.executor === work.executor) ??
						policy.rules
							.flatMap((row) => row.routes)
							.find((route) => route.executor === work.executor) ?? {
							executor: executorSchema.parse(work.executor),
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
				`${route.executor}: ${budget?.backoffKind === "preparation" ? "native setup" : "budget"} backoff until ${new Date(budget!.backoffUntil!).toISOString()}`,
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
			...executionSettings(route.executor, route),
			/** Earlier tools in the rule that could not take it, and why. */
			skipped: rejected,
			model:
				route.executor === "tedi"
					? policy.tedi
					: route.executor === "opencode"
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
