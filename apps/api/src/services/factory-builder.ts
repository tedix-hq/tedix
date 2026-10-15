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
	resolveOwner(ref: string): Promise<{ id: string; name: string } | null>;
	workspaceExists(workspaceId: string): Promise<boolean>;
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
): string {
	const hash = fnv1a(slug);
	let minute = hash % 60;
	if (minute % 30 === 0) minute += 7;
	const hour = (hash >>> 8) % 24;
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
		return ["Re-run with dryRun: false to create the missing parts.", check];
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
	const owner = await store.resolveOwner(input.ownerTedi);
	if (!owner) {
		throw new FactoryBuildError(
			"BAD_REQUEST",
			`No active tedi "${input.ownerTedi}" in this organization; pass its id, slug or exact name.`,
		);
	}
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
	if (bound && bound.slug !== slug) {
		throw new FactoryBuildError(
			"CONFLICT",
			`Project ${state.project?.key} already belongs to factory "${bound.slug}".`,
		);
	}
	const cron =
		state.schedule?.cron ?? staggeredFactoryCron(slug, input.cadence);
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
			title: `${name} factory`,
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
		maxProposals: input.maxProposals,
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
			name: `${name} factory`,
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
			title: `${name} factory health`,
			description: `Standing health item for the ${name} factory. Each run posts its scorecard here.\n\nGoal: ${input.goal}`,
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
			current.workspaceId === desired.workspaceId;
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
		projectId,
		projectKey: state.project?.key ?? projectKey,
		objectiveId,
		healthWorkItemId,
		skillId,
		skillSlug: state.skill?.slug ?? slug,
		skillLifecycleState: lifecycleState,
		workspaceId: workspaceId ?? bound?.workspaceId ?? null,
		cron,
		nextFireAt,
		steps,
		nextActions: nextActions({ slug, skillId, lifecycleState, dryRun }),
	};
}
