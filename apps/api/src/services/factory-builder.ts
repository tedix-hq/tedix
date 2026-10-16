/**
 * `create_factory` orchestration: goal in, operating factory out.
 *
 * Each part is looked up before it is created, so a re-run with the same slug
 * creates nothing and returns the same ids. A partial failure leaves the parts
 * already written; re-running completes the rest. D1 offers no transaction
 * across these writes, and each one reuses its domain's own create path.
 */

import type {
	CreateFactoryInput,
	CreateFactoryResult,
	FactoryCadence,
	FactoryOutputKind,
} from "@tedix/api-contract/schemas/factories";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	type FactoryBinding,
	type FactoryBuildState,
	factoryBindingMetadata,
	factoryHealthIntentId,
	readFactoryBinding,
} from "@tedix/db/queries/factories";
import {
	factoryTitle,
	type RenderedFactoryLane,
	renderFactoryLane,
} from "./factory-lane-template";

export class FactoryBuildError extends Error {
	constructor(
		readonly code: "BAD_REQUEST" | "CONFLICT",
		message: string,
	) {
		super(message);
	}
}

/** The writes and lookups a build needs; the router binds them to D1. */
export interface FactoryStore {
	/** A signed-in human or operator key may activate the lane skill. */
	canActivate: boolean;
	load(params: {
		slug: string;
		projectKey: string;
	}): Promise<FactoryBuildState>;
	/** The calling tedi, when a tedi (not a human) calls. */
	callerTediId: string | null;
	/** The organization's active (unretired) tedis. */
	listOwnerCandidates(): Promise<FactoryOwnerCandidate[]>;
	workspaceExists(workspaceId: string): Promise<boolean>;
	/** An active Output of this organization, by id. */
	findOutputById(outputId: string): Promise<FactoryOutputRef | null>;
	/** The newest active Output of this kind and title in the Workspace. */
	findOutputByTitle(params: {
		workspaceId: string;
		title: string;
		kind: FactoryOutputKind;
	}): Promise<FactoryOutputRef | null>;
	createObjective(params: {
		ownerTediId: string;
		title: string;
		goal: string;
	}): Promise<string>;
	createProject(params: {
		key: string;
		name: string;
		goal: string;
		ownerTediId: string;
		objectiveId: string;
		metadata: Record<string, JsonValue>;
	}): Promise<{ id: string; key: string }>;
	/** Merge the binding into project metadata; link the objective if unset. */
	bindProject(params: {
		projectId: string;
		metadata: Record<string, JsonValue>;
		objectiveId: string | null;
	}): Promise<void>;
	createHealthItem(params: {
		title: string;
		description: string;
		projectId: string;
		objectiveId: string;
		ownerTediId: string;
		sourceIntentId: string;
		slug: string;
	}): Promise<string>;
	createLaneSkill(
		params: RenderedFactoryLane & { slug: string; ownerTediId: string },
	): Promise<{ id: string; lifecycleState: string | null }>;
	activateLaneSkill(
		skillId: string,
	): Promise<{ lifecycleState: string | null; nextFireAt: string | null }>;
}

export interface FactoryOutputRef {
	id: string;
	title: string;
	kind: string;
}

export interface FactoryOwnerCandidate {
	id: string;
	slug: string;
	name: string;
	displayName: string | null;
	createdAt: string | null;
	/** An operator tedi (org_admin or platform_admin profile). */
	operator: boolean;
}

/** Words an agent uses for "the org's default tedi". Home is not itself a tedi. */
const DEFAULT_OWNER_ALIASES = new Set(["home", "default", "tedi"]);
/** Words for "the calling tedi", falling back to the default. */
const CALLER_OWNER_ALIASES = new Set(["me", "self", "myself"]);
const MAX_LISTED_OWNERS = 20;

function ownerLabel(tedi: FactoryOwnerCandidate): string {
	const name = tedi.displayName || tedi.name;
	return name && name !== tedi.slug ? `${tedi.slug} (${name})` : tedi.slug;
}

/**
 * The org's default tedi: its oldest operator (org_admin, as the first tedi
 * is provisioned, or platform_admin), else the oldest active tedi.
 */
export function defaultFactoryOwner(
	candidates: readonly FactoryOwnerCandidate[],
): FactoryOwnerCandidate | null {
	const oldestFirst = [...candidates].sort((a, b) =>
		(a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
	);
	return oldestFirst.find((tedi) => tedi.operator) ?? oldestFirst[0] ?? null;
}

/**
 * Resolve `ownerTedi`: omitted or "me" is the calling tedi, else the default;
 * "home" or "default" is the org's default tedi; anything else matches an id,
 * slug or name. A miss names the valid choices so the caller can retry.
 */
export function resolveFactoryOwner(
	ref: string | undefined,
	candidates: readonly FactoryOwnerCandidate[],
	callerTediId: string | null,
): { id: string; name: string } {
	const pick = (tedi: FactoryOwnerCandidate) => ({
		id: tedi.id,
		name: tedi.displayName || tedi.name,
	});
	if (candidates.length === 0) {
		throw new FactoryBuildError(
			"BAD_REQUEST",
			"This organization has no active tedi to own the factory; create one first.",
		);
	}
	const fallback = defaultFactoryOwner(candidates);
	const wanted = ref?.trim().toLowerCase() ?? "";
	if (!wanted || CALLER_OWNER_ALIASES.has(wanted)) {
		const caller = candidates.find((tedi) => tedi.id === callerTediId);
		if (caller) return pick(caller);
		if (fallback) return pick(fallback);
	}
	if (DEFAULT_OWNER_ALIASES.has(wanted) && fallback) {
		const exact = candidates.find((tedi) => tedi.slug.toLowerCase() === wanted);
		return pick(exact ?? fallback);
	}
	const exact = candidates.find(
		(tedi) =>
			tedi.id.toLowerCase() === wanted || tedi.slug.toLowerCase() === wanted,
	);
	if (exact) return pick(exact);
	const named = candidates.filter(
		(tedi) =>
			tedi.name.toLowerCase() === wanted ||
			(tedi.displayName ?? "").toLowerCase() === wanted,
	);
	const [only] = named;
	if (named.length === 1 && only) return pick(only);
	const choices = (named.length > 1 ? named : candidates)
		.slice(0, MAX_LISTED_OWNERS)
		.map(ownerLabel)
		.join(", ");
	const more =
		named.length <= 1 && candidates.length > MAX_LISTED_OWNERS
			? `, and ${candidates.length - MAX_LISTED_OWNERS} more`
			: "";
	const reason =
		named.length > 1
			? `"${ref}" names ${named.length} tedis; pass a slug`
			: `No active tedi "${ref}" in this organization`;
	throw new FactoryBuildError(
		"BAD_REQUEST",
		`${reason}. Valid ownerTedi slugs: ${choices}${more}. Or omit ownerTedi to use the default tedi${fallback ? ` "${fallback.slug}"` : ""}.`,
	);
}

const MAX_SLUG = 36;

/** Kebab-case slug, at most 36 characters. */
export function factorySlugFrom(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG)
		.replace(/-+$/g, "");
}

/** "Keep the docs accurate against the code." → "Keep the docs accurate". */
export function factoryNameFromGoal(goal: string): string {
	const words = goal
		.replace(/[^\p{L}\p{N}\s-]/gu, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 4)
		.join(" ");
	const name = words.slice(0, 60).trim() || "Factory";
	return name.charAt(0).toUpperCase() + name.slice(1);
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Flag goal wording the chosen options do not cover, naming the option that
 * does. The build never changes because of the goal's wording.
 */
export function factoryGoalLimits(
	goal: string,
	options: { cadence: FactoryCadence; output: string | null } = {
		cadence: "daily",
		output: null,
	},
): string[] {
	const notes: string[] = [];
	if (/\bevery\s+\d+\s+minutes?\b|\bper\s+minute\b/i.test(goal)) {
		notes.push(
			'Factories run at most hourly: cadence "hourly" (CLI --cadence hourly). A job that runs every few minutes needs its own scheduled skill.',
		);
	} else if (
		options.cadence !== "hourly" &&
		/\b(?:hourly|every\s+(?:\d+\s+)?hours?|per\s+hour)\b/i.test(goal)
	) {
		notes.push(
			`The goal asks for an hourly run, but cadence is "${options.cadence}". Pass cadence: "hourly" (CLI --cadence hourly), and everyHours (CLI --every-hours) for every N hours.`,
		);
	}
	if (
		!options.output &&
		/\b(?:write|update|append|publish|add)\b[^.!?\n]{0,120}\b(?:into|to|in)\s+(?:(?:a|an|the|my|our|your|shared)\s+)*(?:doc|document|Output|sheet|spreadsheet|page|Notion)\b/i.test(
			goal,
		)
	) {
		notes.push(
			'The goal names a document, but no output was given, so runs only file Work proposals and a scorecard. Pass output: "<Output id or title>" (CLI --output) to write each run\'s summary into a Tedix document or sheet.',
		);
	}
	if (/\bNotion\b/i.test(goal)) {
		notes.push(
			"The report lane writes only Tedix document and sheet Outputs, not Notion pages.",
		);
	}
	return notes;
}

function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * A daily cron derived from the slug, so factories spread across the day
 * instead of all firing at :00. Minutes :00 and :30 are avoided because every
 * hand-written schedule lands there.
 */
export function staggeredFactoryCron(
	slug: string,
	cadence: FactoryCadence,
	everyHours = 1,
): string {
	const hash = fnv1a(slug);
	let minute = hash % 60;
	if (minute % 30 === 0) minute += 7;
	const hour = (hash >>> 8) % 24;
	if (cadence === "hourly") {
		if (everyHours <= 1) return `${minute} * * * *`;
		const hours: number[] = [];
		for (let at = hour % everyHours; at < 24; at += everyHours) hours.push(at);
		return `${minute} ${hours.join(",")} * * *`;
	}
	if (cadence === "twice_daily") {
		const hours = [hour, (hour + 12) % 24].sort((a, b) => a - b);
		return `${minute} ${hours.join(",")} * * *`;
	}
	return `${minute} ${hour} * * *`;
}

function nextActions(params: {
	slug: string;
	skillId: string | null;
	lifecycleState: string | null;
	dryRun: boolean;
}): string[] {
	const check = `Check it daily: inspect_factory_health({ factory: "${params.slug}" }) or \`tedix factory status ${params.slug}\`.`;
	if (params.dryRun) {
		return [
			"Re-run without dryRun (CLI: without --dry-run) to create the missing parts.",
			check,
		];
	}
	const probe = `run_skill_workflow({ slug: "${params.slug}", params: { probe: true } })`;
	if (params.lifecycleState === "draft") {
		return [
			`Prove the lane: ${probe}. A probe reads the project's Work and writes nothing.`,
			`Then a signed-in human activates it, which creates the schedule: improve_skills({ id: "${params.skillId ?? "<skill id>"}", lifecycleState: "active", force: true }), or re-run create_factory as that human.`,
			check,
		];
	}
	return [`Prove the lane now: ${probe}.`, check];
}

/**
 * Resolve `output`: an id must name an active document or sheet of this
 * organization; a title reuses the newest match in the Workspace, else the
 * first run creates it there.
 */
async function resolveFactoryOutput(
	store: FactoryStore,
	params: {
		ref: string;
		kind: FactoryOutputKind;
		workspaceId: string | null;
	},
): Promise<{
	output: NonNullable<FactoryBinding["output"]>;
	step: CreateFactoryResult["steps"][number];
}> {
	if (UUID_RE.test(params.ref)) {
		const found = await store.findOutputById(params.ref);
		if (!found) {
			throw new FactoryBuildError(
				"BAD_REQUEST",
				`Output ${params.ref} is not an active Output in this organization.`,
			);
		}
		if (found.kind !== "document" && found.kind !== "sheet") {
			throw new FactoryBuildError(
				"BAD_REQUEST",
				`Output ${params.ref} is a ${found.kind}; a factory writes into a document or a sheet.`,
			);
		}
		return {
			output: { id: found.id, title: found.title, kind: found.kind },
			step: { resource: "output", action: "reused", id: found.id },
		};
	}
	if (!params.workspaceId) {
		throw new FactoryBuildError(
			"BAD_REQUEST",
			"An output named by title needs workspaceId (CLI --workspace-id), the Workspace to find or create it in. Or pass the Output id.",
		);
	}
	const found = await store.findOutputByTitle({
		workspaceId: params.workspaceId,
		title: params.ref,
		kind: params.kind,
	});
	if (found) {
		return {
			output: { id: found.id, title: found.title, kind: params.kind },
			step: { resource: "output", action: "reused", id: found.id },
		};
	}
	return {
		output: { id: null, title: params.ref, kind: params.kind },
		step: {
			resource: "output",
			action: "would_create",
			id: null,
			note: `the first run creates ${params.kind} "${params.ref}"`,
		},
	};
}

export async function buildFactory(
	store: FactoryStore,
	input: CreateFactoryInput,
): Promise<CreateFactoryResult> {
	const name = input.name ?? factoryNameFromGoal(input.goal);
	const slug = input.slug ?? factorySlugFrom(name);
	if (slug.length < 2) {
		throw new FactoryBuildError(
			"BAD_REQUEST",
			"Could not derive a slug from the name; pass slug explicitly.",
		);
	}
	const projectKey = input.projectKey ?? slug.toUpperCase();
	if (input.everyHours !== undefined && input.cadence !== "hourly") {
		throw new FactoryBuildError(
			"BAD_REQUEST",
			'everyHours needs cadence "hourly".',
		);
	}
	if (input.outputKind && !input.output) {
		throw new FactoryBuildError(
			"BAD_REQUEST",
			"outputKind needs output (an Output id or title).",
		);
	}
	const everyHours =
		input.cadence === "hourly" ? (input.everyHours ?? 1) : null;
	const owner = resolveFactoryOwner(
		input.ownerTedi,
		await store.listOwnerCandidates(),
		store.callerTediId,
	);
	const workspaceId = input.workspaceId ?? null;
	if (workspaceId && !(await store.workspaceExists(workspaceId))) {
		throw new FactoryBuildError(
			"BAD_REQUEST",
			`Workspace ${workspaceId} is not in this organization.`,
		);
	}

	const state = await store.load({ slug, projectKey });
	const bound = state.project
		? readFactoryBinding(state.project.metadata)
		: null;
	const warnings = factoryGoalLimits(input.goal, {
		cadence: input.cadence,
		output: input.output ?? null,
	});
	// The lane renders its Output once; an existing lane keeps its binding.
	let output: FactoryBinding["output"] = state.skill
		? (bound?.output ?? null)
		: null;
	let outputStep: CreateFactoryResult["steps"][number] | null = null;
	if (input.output && state.skill) {
		const wanted = input.output.toLowerCase();
		if (
			output?.id !== input.output &&
			output?.title?.toLowerCase() !== wanted
		) {
			warnings.push(
				"The lane already exists, so its output and cadence stay as built. Archive the factory and create it again to change them.",
			);
		}
	} else if (input.output) {
		const resolved = await resolveFactoryOutput(store, {
			ref: input.output,
			kind: input.outputKind ?? "document",
			workspaceId: workspaceId ?? bound?.workspaceId ?? null,
		});
		output = resolved.output;
		outputStep = resolved.step;
	}
	if (bound && bound.slug !== slug) {
		throw new FactoryBuildError(
			"CONFLICT",
			`Project ${state.project?.key} already belongs to factory "${bound.slug}".`,
		);
	}
	const cron =
		state.schedule?.cron ??
		staggeredFactoryCron(slug, input.cadence, everyHours ?? 1);
	const steps: CreateFactoryResult["steps"] = [];
	const dryRun = input.dryRun;
	let wrote = false;

	// Objective — reuse the project's, else the binding's, else create one.
	let objectiveId = state.project?.objectiveId ?? bound?.objectiveId ?? null;
	if (objectiveId) {
		steps.push({ resource: "objective", action: "reused", id: objectiveId });
	} else if (dryRun) {
		steps.push({ resource: "objective", action: "would_create", id: null });
	} else {
		objectiveId = await store.createObjective({
			ownerTediId: owner.id,
			title: factoryTitle(name),
			goal: input.goal,
		});
		wrote = true;
		steps.push({ resource: "objective", action: "created", id: objectiveId });
	}

	const binding = (patch: Partial<FactoryBinding>): FactoryBinding => ({
		slug,
		name,
		skillId: bound?.skillId ?? null,
		objectiveId,
		healthWorkItemId: bound?.healthWorkItemId ?? null,
		workspaceId: workspaceId ?? bound?.workspaceId ?? null,
		template: input.template,
		cadence: input.cadence,
		everyHours,
		maxProposals: input.maxProposals,
		output,
		...patch,
	});

	// Project — reuse the bound one, link one with the key, or create it.
	let projectId = state.project?.id ?? null;
	if (state.project) {
		steps.push({
			resource: "project",
			action: bound ? "reused" : "linked",
			id: state.project.id,
		});
	} else if (dryRun) {
		steps.push({ resource: "project", action: "would_create", id: null });
	} else {
		const created = await store.createProject({
			key: projectKey,
			name: factoryTitle(name),
			goal: input.goal,
			ownerTediId: owner.id,
			objectiveId: objectiveId!,
			metadata: { factory: factoryBindingMetadata(binding({})) },
		});
		projectId = created.id;
		wrote = true;
		steps.push({ resource: "project", action: "created", id: projectId });
	}

	// Standing health Work Item, keyed by the slug.
	let healthWorkItemId = state.healthWorkItemId;
	if (healthWorkItemId) {
		steps.push({
			resource: "health_work_item",
			action: "reused",
			id: healthWorkItemId,
		});
	} else if (dryRun) {
		steps.push({
			resource: "health_work_item",
			action: "would_create",
			id: null,
		});
	} else {
		healthWorkItemId = await store.createHealthItem({
			title: `${factoryTitle(name)} health`,
			description: `Standing health item for the ${factoryTitle(name)}. Each run posts its scorecard here.\n\nGoal: ${input.goal}`,
			projectId: projectId!,
			objectiveId: objectiveId!,
			ownerTediId: owner.id,
			sourceIntentId: factoryHealthIntentId(slug),
			slug,
		});
		wrote = true;
		steps.push({
			resource: "health_work_item",
			action: "created",
			id: healthWorkItemId,
		});
	}

	// Lane skill from the template. An existing lane is never re-rendered.
	let skillId = state.skill?.id ?? null;
	let lifecycleState = state.skill?.lifecycleState ?? null;
	if (state.skill) {
		steps.push({
			resource: "skill",
			action: bound?.skillId === state.skill.id ? "reused" : "linked",
			id: state.skill.id,
			...(state.skill.tediId && state.skill.tediId !== owner.id
				? { note: `owned by tedi ${state.skill.tediId}, not ${owner.id}` }
				: {}),
		});
	} else if (dryRun) {
		steps.push({ resource: "skill", action: "would_create", id: null });
	} else {
		const lane = renderFactoryLane(input.template, {
			slug,
			name,
			goal: input.goal,
			cron,
			ownerTediId: owner.id,
			projectId: projectId!,
			objectiveId: objectiveId!,
			healthWorkItemId: healthWorkItemId!,
			workspaceId,
			maxProposals: input.maxProposals,
			cadence: input.cadence,
			output,
		});
		const created = await store.createLaneSkill({
			...lane,
			slug,
			ownerTediId: owner.id,
		});
		skillId = created.id;
		lifecycleState = created.lifecycleState;
		wrote = true;
		steps.push({ resource: "skill", action: "created", id: skillId });
	}

	if (outputStep) steps.push(outputStep);

	// Schedule — exists once the lane is active.
	let nextFireAt = state.schedule?.nextFireAt ?? null;
	if (state.schedule) {
		steps.push({ resource: "schedule", action: "reused", id: skillId });
	} else if (dryRun) {
		steps.push({
			resource: "schedule",
			action: "would_create",
			id: null,
			note: store.canActivate
				? `active, cron ${cron}`
				: "stays a draft until a proof run and a human activation",
		});
	} else if (skillId && lifecycleState === "draft" && store.canActivate) {
		const activated = await store.activateLaneSkill(skillId);
		lifecycleState = activated.lifecycleState;
		nextFireAt = activated.nextFireAt;
		wrote = true;
		steps.push({
			resource: "schedule",
			action: "activated",
			id: skillId,
			note: `cron ${cron}`,
		});
	}

	// Record the binding once every id is known.
	if (!dryRun && projectId) {
		const desired = binding({ skillId, healthWorkItemId });
		const current = bound;
		const same =
			current &&
			current.skillId === desired.skillId &&
			current.healthWorkItemId === desired.healthWorkItemId &&
			current.objectiveId === desired.objectiveId &&
			current.workspaceId === desired.workspaceId &&
			JSON.stringify(current.output) === JSON.stringify(desired.output);
		if (!same) {
			await store.bindProject({
				projectId,
				metadata: { factory: factoryBindingMetadata(desired) },
				objectiveId:
					state.project && !state.project.objectiveId ? objectiveId : null,
			});
			wrote = true;
		}
	}

	return {
		slug,
		name,
		dryRun,
		status: dryRun ? "planned" : wrote ? "created" : "unchanged",
		ownerTediId: owner.id,
		ownerTediName: owner.name,
		projectId,
		projectKey: state.project?.key ?? projectKey,
		objectiveId,
		healthWorkItemId,
		skillId,
		skillSlug: state.skill?.slug ?? slug,
		skillLifecycleState: lifecycleState,
		workspaceId: workspaceId ?? bound?.workspaceId ?? null,
		output: output
			? {
					id: output.id,
					title: output.title,
					kind: output.kind === "sheet" ? "sheet" : "document",
				}
			: null,
		cron,
		nextFireAt,
		steps,
		warnings,
		nextActions: nextActions({ slug, skillId, lifecycleState, dryRun }),
	};
}
