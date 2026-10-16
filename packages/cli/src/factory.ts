import { FLOW_EXIT_FAIL } from "./flow";
import { cyan, dim, errorText, green, red, yellow } from "./format";
import {
	readGatewayProjection,
	rowsFrom,
	type GatewayProjectionClient,
} from "./gateway-projection";

export interface FactoryOptions {
	goal?: string;
	owner?: string;
	cadence?: string;
	template?: string;
	slug?: string;
	name?: string;
	maxProposals?: string;
	workspaceId?: string;
	project?: string;
	dryRun?: boolean;
	runs?: number;
}

export interface FactoryContext {
	client: GatewayProjectionClient;
	color: { enabled: boolean };
	json: boolean;
	factory: FactoryOptions;
}

export function factoryUsage(): string {
	return [
		"tedix factory — build a factory from a goal and check that it delivers",
		"",
		"Verbs:",
		'  tedix factory create --goal "<what it delivers>" [--owner <tedi>]',
		"        [--cadence daily|twice_daily] [--template report] [--name <text>]",
		"        [--slug <slug>] [--max-proposals <n>] [--workspace-id <uuid>]",
		"        [--project <KEY>] [--dry-run]",
		"  tedix factory status [<slug>] [--limit <runs>]",
		"",
		"`create` makes the Work project and objective, a scheduled lane skill from",
		"the template and a standing health Work Item in one call. Re-running it with",
		"the same slug changes nothing. Factories run daily by default, at a minute",
		"other than :00 or :30.",
		"",
		"`status` gives each factory one verdict: healthy, idle (ran but delivered",
		"nothing), failing, not_firing, paused (schedule turned off) or pending.",
		"With a slug it lists the recent runs and what each delivered.",
		"",
		"Pause, resume or archive a factory by revising its lane skill; see",
		"docs/public/factory-agent-guide.md (Pause or archive a factory).",
	].join("\n");
}

const VERDICT_COLORS: Record<
	string,
	(text: string, color: { enabled: boolean }) => string
> = {
	healthy: green,
	pending: dim,
	paused: dim,
	idle: yellow,
	failing: red,
	not_firing: red,
};

function verdictLabel(verdict: string, color: { enabled: boolean }): string {
	const paint = VERDICT_COLORS[verdict] ?? ((text: string) => text);
	return paint(verdict.padEnd(11), color);
}

/** Build the `create_factory` input; omitted flags take the server defaults. */
export function createFactoryInput(
	options: FactoryOptions,
): Record<string, unknown> {
	if (!options.goal?.trim()) {
		throw new Error('tedix factory create needs --goal "<what it delivers>"');
	}
	const input: Record<string, unknown> = { goal: options.goal.trim() };
	// Without --owner the server picks the organization's default tedi.
	if (options.owner?.trim()) input.ownerTedi = options.owner.trim();
	if (options.cadence) input.cadence = options.cadence;
	if (options.template) input.template = options.template;
	if (options.slug) input.slug = options.slug;
	if (options.name) input.name = options.name;
	if (options.workspaceId) input.workspaceId = options.workspaceId;
	if (options.project) input.projectKey = options.project;
	if (options.dryRun) input.dryRun = true;
	if (options.maxProposals !== undefined) {
		const value = Number(options.maxProposals);
		if (!Number.isInteger(value) || value < 0 || value > 10) {
			throw new Error("--max-proposals must be a whole number from 0 to 10");
		}
		input.maxProposals = value;
	}
	return input;
}

async function createFactory(ctx: FactoryContext): Promise<number> {
	const value = await readGatewayProjection(
		ctx.client,
		"projects.create_factory",
		createFactoryInput(ctx.factory),
	);
	if (ctx.json) {
		console.log(JSON.stringify(value));
		return 0;
	}
	const result = (value ?? {}) as Record<string, unknown>;
	console.log(
		`${green(String(result.status ?? "?"), ctx.color)} factory ${cyan(String(result.slug ?? "?"), ctx.color)} (${String(result.name ?? "")})`,
	);
	for (const step of rowsFrom(result.steps)) {
		console.log(
			`  ${String(step.resource ?? "").padEnd(17)} ${String(step.action ?? "").padEnd(13)} ${String(step.id ?? "")}${step.note ? dim(`  ${String(step.note)}`, ctx.color) : ""}`,
		);
	}
	const nextFire = result.nextFireAt
		? String(result.nextFireAt)
		: result.dryRun
			? "set when it is created"
			: "none (draft)";
	console.log(
		`  cron ${String(result.cron ?? "?")} UTC, next fire ${nextFire}`,
	);
	const actions = Array.isArray(result.nextActions) ? result.nextActions : [];
	if (actions.length) {
		console.log("");
		for (const action of actions) console.log(`Next: ${String(action)}`);
	}
	return 0;
}

const OVERVIEW_FIELDS = [
	"slug",
	"verdict",
	"reason",
	"ownerTediName",
	"ranToday",
	"nextFireAt",
] as const;

async function factoryStatus(
	ctx: FactoryContext,
	slug: string | undefined,
): Promise<number> {
	const value = await readGatewayProjection(
		ctx.client,
		"projects.inspect_factory_health",
		{
			...(slug ? { factory: slug } : {}),
			...(ctx.factory.runs ? { runs: ctx.factory.runs } : {}),
		},
		// Every factory with its runs outgrows the gateway's result cap, and
		// the overview prints only these fields.
		slug ? undefined : OVERVIEW_FIELDS,
	);
	if (ctx.json) {
		console.log(JSON.stringify(value));
		return 0;
	}
	const rows = rowsFrom(value, "data");
	if (rows.length === 0) {
		console.log(dim("no factories", ctx.color));
		return 0;
	}
	if (!slug) {
		const severity = [
			"failing",
			"not_firing",
			"idle",
			"pending",
			"healthy",
			"paused",
		];
		const rank = (verdict: unknown) => {
			const index = severity.indexOf(String(verdict));
			return index < 0 ? severity.length : index;
		};
		rows.sort((a, b) => rank(a.verdict) - rank(b.verdict));
	}
	for (const row of rows) {
		console.log(
			`${verdictLabel(String(row.verdict ?? "?"), ctx.color)} ${cyan(String(row.slug ?? "?"), ctx.color)}  ${String(row.ownerTediName ?? "")}  ran today: ${row.ranToday ? "yes" : "no"}  next: ${row.verdict === "paused" ? "- (paused)" : String(row.nextFireAt ?? "-")}`,
		);
		console.log(dim(`            ${String(row.reason ?? "")}`, ctx.color));
		if (!slug) continue;
		const proof = row.lastProofRun as Record<string, unknown> | null;
		console.log(
			`            last proof run: ${proof ? `${String(proof.status)} ${String(proof.runId)}` : "none"}`,
		);
		const runs = rowsFrom(row.runs);
		for (const run of runs) {
			const outputs = (run.outputs ?? {}) as Record<string, unknown>;
			console.log(
				`            ${String(run.firedAt ?? "?").padEnd(24)} ${String(run.status ?? "?").padEnd(10)} work ${String(outputs.workItemsCreated ?? 0)}, comments ${String(outputs.comments ?? 0)}, outputs ${String(outputs.outputRevisions ?? 0)}, scorecards ${String(outputs.scorecards ?? 0)}  ${String(run.runId ?? "")}`,
			);
			if (run.error)
				console.log(
					dim(`              error: ${String(run.error)}`, ctx.color),
				);
		}
		if (runs.length > 0)
			console.log(
				dim("            read a run: tedix skill status <runId>", ctx.color),
			);
	}
	if (!slug) {
		const counts = new Map<string, number>();
		for (const row of rows) {
			const verdict = String(row.verdict ?? "?");
			counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
		}
		console.log(
			dim(
				`${rows.length} factories: ${Array.from(counts, ([verdict, count]) => `${count} ${verdict}`).join(", ")}`,
				ctx.color,
			),
		);
	}
	return 0;
}

export async function runFactoryCommand(
	args: string,
	ctx: FactoryContext,
): Promise<number> {
	const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	try {
		switch (verb) {
			case "":
			case "help":
				console.log(factoryUsage());
				return 0;
			case "create":
				return await createFactory(ctx);
			case "status":
				return await factoryStatus(ctx, rest[0]);
			default:
				throw new Error(
					`unknown factory verb "${verb}" — expected create or status`,
				);
		}
	} catch (error) {
		console.error(errorText(error));
		return FLOW_EXIT_FAIL;
	}
}
