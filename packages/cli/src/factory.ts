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
		"  tedix factory pause <slug>",
		"  tedix factory resume <slug>",
		"  tedix factory archive <slug>",
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
		"`pause`, `resume` and `archive` revise the lane through improve_skills; see",
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
	console.log(
		`  owner ${String(result.ownerTediName ?? "?")} (${String(result.ownerTediId ?? "?")})`,
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
	for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
		console.log(`Note: ${String(warning)}`);
	}
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

/** Change only the direct enabled child of frontmatter capabilities.schedule. */
export function setScheduleEnabled(content: string, enabled: boolean): string {
	const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const text = (index: number) => (lines[index] ?? "").replace(/\r?\n$/, "");
	const end = lines.findIndex((_, i) => i > 0 && /^---[ \t]*$/.test(text(i)));
	const missing = () =>
		new Error("Skill frontmatter has no capabilities.schedule block");
	if (text(0) !== "---" || end < 0) throw missing();
	const capabilities = lines.findIndex(
		(_, i) => i > 0 && i < end && /^capabilities:[ \t]*(?:#.*)?$/.test(text(i)),
	);
	if (capabilities < 0) throw missing();
	let capabilitiesEnd = capabilities + 1;
	while (capabilitiesEnd < end && !/^[^\s#]/.test(text(capabilitiesEnd)))
		capabilitiesEnd++;
	const indent = (i: number) => /^ */.exec(text(i))![0].length;
	const isKey = (i: number) => /^ +[^\s#][^:]*:/.test(text(i));
	const keys = Array.from(
		{ length: capabilitiesEnd - capabilities - 1 },
		(_, i) => capabilities + 1 + i,
	).filter(isKey);
	const childIndent = Math.min(...keys.map(indent));
	const schedule = keys.find(
		(i) =>
			indent(i) === childIndent && /^ +schedule:[ \t]*(?:#.*)?$/.test(text(i)),
	);
	if (schedule === undefined) throw missing();
	let scheduleEnd = schedule + 1;
	while (
		scheduleEnd < capabilitiesEnd &&
		(!text(scheduleEnd).trim() ||
			/^\s*#/.test(text(scheduleEnd)) ||
			indent(scheduleEnd) > childIndent)
	)
		scheduleEnd++;
	const children = Array.from(
		{ length: scheduleEnd - schedule - 1 },
		(_, i) => schedule + 1 + i,
	).filter(isKey);
	const enabledIndent = children.length
		? Math.min(...children.map(indent))
		: childIndent + 2;
	const existing = children.filter(
		(i) => indent(i) === enabledIndent && /^ +enabled:/.test(text(i)),
	);
	const newline = lines[0]!.endsWith("\r\n") ? "\r\n" : "\n";
	if (enabled) {
		for (const i of existing.reverse()) lines.splice(i, 1);
	} else if (existing.length) {
		for (const i of existing)
			lines[i] = `${" ".repeat(enabledIndent)}enabled: false${newline}`;
	} else {
		lines.splice(
			schedule + 1,
			0,
			`${" ".repeat(enabledIndent)}enabled: false${newline}`,
		);
	}
	return lines.join("");
}

async function reviseFactory(
	ctx: FactoryContext,
	verb: "pause" | "resume" | "archive",
	slug: string | undefined,
): Promise<number> {
	if (!slug) throw new Error(`tedix factory ${verb} needs <slug>`);
	const health = await readGatewayProjection(
		ctx.client,
		"projects.inspect_factory_health",
		{ factory: slug },
		[
			"slug",
			"skillId",
			"scheduleEnabled",
			"healthWorkItemId",
			"projectId",
			"objectiveId",
		],
	);
	const lane = rowsFrom(health, "data").find((row) => row.slug === slug);
	if (!lane) throw new Error(`No factory "${slug}".`);
	if (typeof lane.skillId !== "string")
		throw new Error(`Factory "${slug}" has no lane skill.`);
	if (verb !== "archive" && lane.scheduleEnabled === (verb === "resume")) {
		console.log(
			ctx.json
				? JSON.stringify(health)
				: `Factory ${slug} is already ${verb === "pause" ? "paused" : "running"}.`,
		);
		return 0;
	}
	let input: Record<string, unknown> = {
		id: lane.skillId,
		lifecycleState: "archived",
	};
	if (verb !== "archive") {
		const skill = await readGatewayProjection(ctx.client, "skills.get_skills", {
			id: lane.skillId,
		});
		const entry = (skill as { entry?: { content?: unknown } } | null)?.entry;
		if (typeof entry?.content !== "string")
			throw new Error(`Lane skill ${lane.skillId} has no content.`);
		input = {
			id: lane.skillId,
			content: setScheduleEnabled(entry.content, verb === "resume"),
			revisionReasoning: `${verb === "pause" ? "Pause" : "Resume"} factory ${slug}.`,
		};
	}
	const result = await readGatewayProjection(
		ctx.client,
		"skills.improve_skills",
		input,
	);
	if (ctx.json) {
		console.log(JSON.stringify(result));
		return 0;
	}
	console.log(
		`Factory ${slug} ${verb === "archive" ? "archived" : verb === "pause" ? "paused" : "resumed"}.`,
	);
	if (verb === "archive") {
		console.log("When nothing else uses these records:");
		if (lane.healthWorkItemId)
			console.log(`Next: tedix work cancel ${String(lane.healthWorkItemId)}`);
		if (lane.projectId)
			console.log(
				`Next: archive_project(${JSON.stringify({ id: lane.projectId })})`,
			);
		if (lane.objectiveId)
			console.log(
				`Next: update_tedi_objectives(${JSON.stringify({ id: lane.objectiveId, status: "completed" })})`,
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
			case "pause":
			case "resume":
			case "archive":
				return await reviseFactory(ctx, verb, rest[0]);
			default:
				throw new Error(
					`unknown factory verb "${verb}" — expected create, status, pause, resume or archive`,
				);
		}
	} catch (error) {
		console.error(errorText(error));
		return FLOW_EXIT_FAIL;
	}
}
