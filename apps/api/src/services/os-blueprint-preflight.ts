/**
 * Blueprint dependency preflight: read-only resolution of one pinned blueprint
 * revision's typed requirements against the CALLER's organization.
 *
 * It never mints authority, never provisions, and never reads a credential
 * value — the connection check asks only whether a token satisfying the
 * declared scopes exists, never what it contains.
 *
 * It emits the platform's single preflight vocabulary
 * (`WorkItemExecutionPreflightDecision`), the same shape Work Item dispatch
 * preflight and governed gadget dispatch already produce. The board's
 * per-dependency states map onto its verdicts one-for-one: `available` is
 * `allowed`, and `missing` / `denied` / `consent_required` / `incompatible`
 * keep their names.
 *
 * A decision is emitted only for a requirement the revision actually DECLARES.
 * An absent kind means "nothing was declared" — never "nothing was checked" —
 * and `resolvedPin` is populated only from a row that was really read.
 */

import type {
	OsBlueprintDefinition,
	OsBlueprintPreflight,
	OsBlueprintResourceBinding,
	OsBlueprintRequirements,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	findCatalogEntry,
	type ModelCatalogEntry,
	parseModelRef,
} from "@tedix/api-contract/schemas/model-catalog";
import type { WorkItemExecutionPreflightDecision } from "@tedix/api-contract/schemas/work-items";
import type { DbClient } from "@tedix/db/client";
import { getSkillEntryBySlug } from "@tedix/db/queries/cognitive/skill-crud";
import {
	getPolicyPackBySlugForOrganization,
	getRuntimeProfileById,
} from "@tedix/db/queries/control-plane/definitions";
import { getTediById } from "@tedix/db/queries/tedis";
import type { ModelPolicy } from "@tedix/db/schema/control-plane";
// The same digest projection the skill-run and blueprint-export paths use.
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { resolveConnectionAvailability } from "./connection-availability";

type Decision = WorkItemExecutionPreflightDecision;

/**
 * Kinds whose failure refuses instantiation. These are the dependencies
 * instantiation REPRODUCES: if a pinned skill, policy pack, model, layout, or
 * output declaration cannot resolve to its exact pin, the workspace that would
 * be created is not the workspace the blueprint describes.
 *
 * `connection` is deliberately absent: connections are runtime credentials,
 * instantiation never copies one, and a workspace whose connections are not yet
 * consented is a normal, recoverable state.
 */
const DEFINITIONAL_KINDS = new Set<Decision["kind"]>([
	"skill",
	"policy_pack",
	"model",
	"layout",
	"output",
]);

const TIER_RANK: Record<ModelCatalogEntry["tier"], number> = {
	economy: 0,
	balanced: 1,
	frontier: 2,
};

async function resolveSkillDecisions(input: {
	db: DbClient;
	organizationId: string;
	requirements: OsBlueprintRequirements;
}): Promise<Decision[]> {
	const decisions: Decision[] = [];
	for (const requirement of input.requirements.skills) {
		const subject = `${requirement.role}:${requirement.slug}`;
		const declaredPin = {
			id: requirement.skillId,
			revision: requirement.revision,
			digest: requirement.workflowSha256,
		};
		// Org-scoped by construction: `getSkillEntryBySlug` takes organizationId
		// positionally, so a slug pinned by another tenant's blueprint can only
		// ever resolve against rows this organization owns.
		const skill = await getSkillEntryBySlug(
			input.db,
			input.organizationId,
			requirement.slug,
		);
		if (!skill) {
			decisions.push({
				kind: "skill",
				subject,
				verdict: "missing",
				reason: `no skill with slug ${requirement.slug} exists in this organization`,
				declaredPin,
				resolvedPin: null,
			});
			continue;
		}
		const resolvedPin = {
			id: skill.id,
			revision: skill.revision ?? null,
			digest: null as string | null,
		};
		if (skill.id !== requirement.skillId) {
			decisions.push({
				kind: "skill",
				subject,
				verdict: "denied",
				reason: `slug ${requirement.slug} is owned by a different skill (${skill.id}) in this organization; the pinned skill ${requirement.skillId} is not reachable here`,
				declaredPin,
				resolvedPin,
			});
			continue;
		}
		if (skill.lifecycleState === "archived") {
			decisions.push({
				kind: "skill",
				subject,
				verdict: "denied",
				reason: `skill ${requirement.slug} is archived`,
				declaredPin,
				resolvedPin,
			});
			continue;
		}
		if ((skill.revision ?? null) !== requirement.revision) {
			decisions.push({
				kind: "skill",
				subject,
				verdict: "incompatible",
				reason: `skill ${requirement.slug} is pinned at revision ${requirement.revision} but has moved to ${skill.revision ?? "unversioned"}; skill revisions version in place, so the pinned bytes cannot be restored — re-pin the blueprint`,
				declaredPin,
				resolvedPin,
			});
			continue;
		}
		if (requirement.workflowSha256) {
			const files = (skill.files ?? null) as Record<string, string> | null;
			const workflowSource = files?.["scripts/workflow.ts"];
			if (!workflowSource) {
				decisions.push({
					kind: "skill",
					subject,
					verdict: "incompatible",
					reason: `skill ${requirement.slug} pins a workflow digest but carries no files['scripts/workflow.ts']`,
					declaredPin,
					resolvedPin,
				});
				continue;
			}
			const digest = await sha256Hex(workflowSource);
			if (digest !== requirement.workflowSha256) {
				decisions.push({
					kind: "skill",
					subject,
					verdict: "incompatible",
					reason: `skill ${requirement.slug} is at revision ${requirement.revision} as pinned, but its workflow content digest has changed`,
					declaredPin,
					resolvedPin: { ...resolvedPin, digest },
				});
				continue;
			}
			decisions.push({
				kind: "skill",
				subject,
				verdict: "allowed",
				reason: `skill ${requirement.slug} resolved at the pinned revision ${requirement.revision} with a matching workflow digest`,
				declaredPin,
				resolvedPin: { ...resolvedPin, digest },
			});
			continue;
		}
		decisions.push({
			kind: "skill",
			subject,
			verdict: "allowed",
			reason: `skill ${requirement.slug} resolved at the pinned revision ${requirement.revision}`,
			declaredPin,
			resolvedPin,
		});
	}
	return decisions;
}

async function resolvePolicyDecisions(input: {
	db: DbClient;
	organizationId: string;
	requirements: OsBlueprintRequirements;
}): Promise<Decision[]> {
	const decisions: Decision[] = [];
	for (const requirement of input.requirements.policies) {
		const subject = `${requirement.scope}:${requirement.slug}`;
		const declaredPin = {
			id: null,
			revision: requirement.version,
			digest: null,
		};
		const pack = await getPolicyPackBySlugForOrganization(
			input.db,
			input.organizationId,
			{
				scope: requirement.scope,
				slug: requirement.slug,
				version: requirement.version,
			},
		);
		if (!pack) {
			decisions.push({
				kind: "policy_pack",
				subject,
				verdict: "missing",
				reason: `no ${requirement.scope}-scoped policy pack ${requirement.slug} is resolvable for this organization`,
				declaredPin,
				resolvedPin: null,
			});
			continue;
		}
		const resolvedPin = { id: pack.id, revision: pack.version, digest: null };
		if (pack.status !== "active") {
			decisions.push({
				kind: "policy_pack",
				subject,
				verdict: "denied",
				reason: `policy pack ${requirement.slug} is ${pack.status}`,
				declaredPin,
				resolvedPin,
			});
			continue;
		}
		if (pack.version !== requirement.version) {
			decisions.push({
				kind: "policy_pack",
				subject,
				verdict: "incompatible",
				reason: `policy pack ${requirement.slug} is pinned at version ${requirement.version} but this organization resolves version ${pack.version}`,
				declaredPin,
				resolvedPin,
			});
			continue;
		}
		decisions.push({
			kind: "policy_pack",
			subject,
			verdict: "allowed",
			reason: `active policy pack ${requirement.slug} resolved at the pinned version ${requirement.version}`,
			declaredPin,
			resolvedPin,
		});
	}
	return decisions;
}

async function resolveRuntimeDecision(input: {
	db: DbClient;
	organizationId: string;
	requirements: OsBlueprintRequirements;
	tediId: string | null;
}): Promise<Decision | null> {
	const runtime = input.requirements.runtime;
	if (!runtime) return null;
	const declaredPin = {
		id: runtime.modelRef,
		revision: null,
		digest: null,
	};
	const subject = runtime.modelRef ?? runtime.minTier ?? "runtime";
	if (!input.tediId) {
		return {
			kind: "model",
			subject,
			verdict: "missing",
			reason:
				"model/runtime compatibility resolves against a target tedi's runtime profile; none was supplied, so nothing could be read",
			declaredPin,
			resolvedPin: null,
		};
	}
	const tedi = await getTediById(input.db, input.tediId);
	if (!tedi || tedi.organizationId !== input.organizationId) {
		return {
			kind: "model",
			subject,
			verdict: "denied",
			reason: "the selected tedi does not exist in this organization",
			declaredPin,
			resolvedPin: null,
		};
	}
	const profile = tedi.runtimeProfileId
		? await getRuntimeProfileById(input.db, tedi.runtimeProfileId)
		: null;
	if (!profile) {
		return {
			kind: "model",
			subject,
			verdict: "missing",
			reason: `tedi ${tedi.slug} has no resolvable runtime profile`,
			declaredPin,
			resolvedPin: null,
		};
	}
	if (profile.status !== "active") {
		return {
			kind: "model",
			subject,
			verdict: "denied",
			reason: `runtime profile ${profile.slug} is ${profile.status}`,
			declaredPin,
			resolvedPin: { id: profile.id, revision: profile.version, digest: null },
		};
	}
	const modelPolicy = profile.config?.modelPolicy as ModelPolicy | undefined;
	const chatModelRef =
		typeof modelPolicy?.chatModelRef === "string"
			? modelPolicy.chatModelRef
			: null;
	const resolvedPin = {
		id: chatModelRef,
		revision: profile.version,
		digest: null,
	};
	if (!chatModelRef) {
		return {
			kind: "model",
			subject,
			verdict: "missing",
			reason: `runtime profile ${profile.slug} declares no chat model ref, so compatibility cannot be established`,
			declaredPin,
			resolvedPin,
		};
	}
	if (runtime.modelRef && runtime.modelRef !== chatModelRef) {
		return {
			kind: "model",
			subject,
			verdict: "incompatible",
			reason: `the blueprint pins ${runtime.modelRef} but runtime profile ${profile.slug} serves ${chatModelRef}`,
			declaredPin,
			resolvedPin,
		};
	}
	const entry = parseModelRef(chatModelRef)
		? findCatalogEntry(chatModelRef)
		: undefined;
	if (!entry) {
		// Unknown stays unknown: an off-catalog ref is not evidence of either
		// compatibility or incompatibility, so it resolves `missing`, not
		// `incompatible`.
		return {
			kind: "model",
			subject,
			verdict: "missing",
			reason: `runtime profile ${profile.slug} serves ${chatModelRef}, which is not in the cognition catalog, so tier and reasoning cannot be resolved`,
			declaredPin,
			resolvedPin,
		};
	}
	if (runtime.minTier && TIER_RANK[entry.tier] < TIER_RANK[runtime.minTier]) {
		return {
			kind: "model",
			subject,
			verdict: "incompatible",
			reason: `the blueprint needs at least the ${runtime.minTier} tier but ${entry.ref} is ${entry.tier}`,
			declaredPin,
			resolvedPin,
		};
	}
	if (runtime.requiresReasoning && !entry.reasoning) {
		return {
			kind: "model",
			subject,
			verdict: "incompatible",
			reason: `the blueprint requires a reasoning model but ${entry.ref} is not one`,
			declaredPin,
			resolvedPin,
		};
	}
	return {
		kind: "model",
		subject,
		verdict: "allowed",
		reason: `runtime profile ${profile.slug} serves ${entry.ref} (${entry.tier}${entry.reasoning ? ", reasoning" : ""}), which satisfies the declaration`,
		declaredPin,
		resolvedPin,
	};
}

/**
 * Layout and output declarations are checked against the SAME revision that
 * declares them: a placement or a producing gadget that the revision does not
 * declare is an internally inconsistent pin, not a tenant-state problem.
 */
function resolveLayoutDecisions(input: {
	definition: OsBlueprintDefinition;
	requirements: OsBlueprintRequirements;
}): Decision[] {
	const layout = input.requirements.layout;
	if (!layout) return [];
	const declared = new Set(input.definition.gadgets.map(({ name }) => name));
	const occupied = new Map<string, string>();
	const problems: string[] = [];
	for (const placement of layout.placements) {
		if (!declared.has(placement.gadget)) {
			problems.push(
				`placement references gadget "${placement.gadget}", which this revision does not declare`,
			);
			continue;
		}
		if (placement.column + placement.width - 1 > layout.columns) {
			problems.push(
				`gadget "${placement.gadget}" overflows the ${layout.columns}-column grid`,
			);
			continue;
		}
		for (
			let row = placement.row;
			row < placement.row + placement.height;
			row++
		) {
			for (
				let column = placement.column;
				column < placement.column + placement.width;
				column++
			) {
				const cell = `${column}:${row}`;
				const holder = occupied.get(cell);
				if (holder) {
					problems.push(
						`gadgets "${holder}" and "${placement.gadget}" overlap at column ${column}, row ${row}`,
					);
				} else {
					occupied.set(cell, placement.gadget);
				}
			}
		}
	}
	if (problems.length > 0) {
		return [
			{
				kind: "layout",
				subject: "layout",
				verdict: "incompatible",
				reason: `the declared layout does not fit the declared gadgets: ${problems.join("; ")}`,
				resolvedPin: null,
			},
		];
	}
	return [
		{
			kind: "layout",
			subject: "layout",
			verdict: "allowed",
			reason: `${layout.placements.length} placement(s) fit the ${layout.columns}-column grid and name only gadgets this revision declares`,
			resolvedPin: null,
		},
	];
}

function resolveOutputDecisions(input: {
	definition: OsBlueprintDefinition;
	requirements: OsBlueprintRequirements;
}): Decision[] {
	const declared = new Set(input.definition.gadgets.map(({ name }) => name));
	return input.requirements.outputs.map((output) =>
		declared.has(output.gadget)
			? {
					kind: "output" as const,
					subject: output.title,
					verdict: "allowed" as const,
					// Says only what was checked: instantiation does not create outputs.
					reason: `declared ${output.kind} produced by gadget "${output.gadget}", which this revision declares`,
					resolvedPin: null,
				}
			: {
					kind: "output" as const,
					subject: output.title,
					verdict: "incompatible" as const,
					reason: `output "${output.title}" names producing gadget "${output.gadget}", which this revision does not declare`,
					resolvedPin: null,
				},
	);
}

async function resolveConnectionDecisions(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId: string;
	ownerUserId: string | null;
	requirements: OsBlueprintRequirements;
}): Promise<Decision[]> {
	const decisions: Decision[] = [];
	const requirements = [
		...input.requirements.connections,
		...(input.requirements.resources ?? []).map((resource) => ({
			providerId: resource.providerId,
			tokenScope: resource.tokenScope,
			scopes: resource.scopes,
		})),
	].filter(
		(requirement, index, all) =>
			all.findIndex(
				(candidate) =>
					candidate.providerId === requirement.providerId &&
					candidate.tokenScope === requirement.tokenScope &&
					JSON.stringify(candidate.scopes) ===
						JSON.stringify(requirement.scopes),
			) === index,
	);
	for (const requirement of requirements) {
		const availability = await resolveConnectionAvailability({
			db: input.db,
			env: input.env,
			organizationId: input.organizationId,
			ownerUserId: input.ownerUserId,
			providerId: requirement.providerId,
			tokenScope: requirement.tokenScope,
			scopes: requirement.scopes,
		});
		decisions.push({
			kind: "connection",
			subject: requirement.providerId,
			verdict: availability.connected
				? "allowed"
				: availability.cause === "no_token"
					? "consent_required"
					: "missing",
			reason:
				availability.cause === "no_token"
					? `${availability.reason}; a user-present Descope Adaptive Connect consent is required to create one`
					: availability.reason,
			resolvedPin: null,
		});
	}
	return decisions;
}

function resolveResourceDecisions(input: {
	requirements: OsBlueprintRequirements;
	bindings: OsBlueprintResourceBinding[];
}): Decision[] {
	const bindings = new Map(
		input.bindings.map((binding) => [binding.slot, binding]),
	);
	return (input.requirements.resources ?? []).map((requirement) => {
		const binding = bindings.get(requirement.slot);
		const subject = `${requirement.slot}:${requirement.providerId}:${requirement.resourceType}`;
		if (!binding) {
			return {
				kind: "workspace_resource" as const,
				subject,
				verdict: "missing" as const,
				reason: `select a ${requirement.label} for resource slot ${requirement.slot}`,
				resolvedPin: null,
			};
		}
		const selected = binding.selection;
		const scopeAllowed =
			requirement.tokenScope === "either" ||
			selected.connectionScope === requirement.tokenScope;
		const scopesAllowed = requirement.scopes.every((scope) =>
			selected.requiredScopes.includes(scope),
		);
		if (
			selected.providerId !== requirement.providerId ||
			selected.resourceType !== requirement.resourceType ||
			!scopeAllowed ||
			!scopesAllowed
		) {
			return {
				kind: "workspace_resource" as const,
				subject,
				verdict: "denied" as const,
				reason: `the selection for ${requirement.slot} does not satisfy its provider, resource type, scope, and grant requirements`,
				resolvedPin: null,
			};
		}
		return {
			kind: "workspace_resource" as const,
			subject,
			verdict: "allowed" as const,
			reason: `${selected.name} is selected for resource slot ${requirement.slot}`,
			resolvedPin: null,
		};
	});
}

export interface OsBlueprintPreflightInput {
	db: DbClient;
	env: CloudflareEnv;
	/** The CALLER's organization — never the organization that authored the blueprint. */
	organizationId: string;
	blueprintId: string;
	revisionId: string;
	revision: number;
	definition: OsBlueprintDefinition;
	/** Target tedi for model/runtime compatibility; null resolves that kind `missing`. */
	tediId?: string | null;
	/** User identity a user-scoped connection could belong to. */
	ownerUserId?: string | null;
	resourceBindings?: OsBlueprintResourceBinding[];
	now?: string;
}

export async function resolveOsBlueprintPreflight(
	input: OsBlueprintPreflightInput,
): Promise<OsBlueprintPreflight> {
	const resolvedAt = input.now ?? new Date().toISOString();
	const requirements = input.definition.requirements;
	const targetTediId = input.tediId ?? null;
	if (!requirements) {
		return {
			blueprintId: input.blueprintId,
			revisionId: input.revisionId,
			revision: input.revision,
			status: "not_configured",
			instantiateAllowed: true,
			targetTediId,
			requirements: null,
			decisions: [],
			blockingReasons: [],
			consentReasons: [],
			configurationReasons: [],
			resolvedAt,
		};
	}

	const [
		skillDecisions,
		policyDecisions,
		runtimeDecision,
		connectionDecisions,
	] = await Promise.all([
		resolveSkillDecisions({
			db: input.db,
			organizationId: input.organizationId,
			requirements,
		}),
		resolvePolicyDecisions({
			db: input.db,
			organizationId: input.organizationId,
			requirements,
		}),
		resolveRuntimeDecision({
			db: input.db,
			organizationId: input.organizationId,
			requirements,
			tediId: targetTediId,
		}),
		resolveConnectionDecisions({
			db: input.db,
			env: input.env,
			organizationId: input.organizationId,
			ownerUserId: input.ownerUserId ?? null,
			requirements,
		}),
	]);

	const decisions: Decision[] = [
		...skillDecisions,
		...policyDecisions,
		...(runtimeDecision ? [runtimeDecision] : []),
		...resolveLayoutDecisions({
			definition: input.definition,
			requirements,
		}),
		...resolveOutputDecisions({ definition: input.definition, requirements }),
		...connectionDecisions,
		...resolveResourceDecisions({
			requirements,
			bindings: input.resourceBindings ?? [],
		}),
	];

	const blockingReasons = [
		...new Set(
			decisions
				.filter(
					(decision) =>
						DEFINITIONAL_KINDS.has(decision.kind) &&
						decision.verdict !== "allowed",
				)
				.map((decision) => decision.reason),
		),
	];
	const consentReasons = [
		...new Set(
			decisions
				.filter(
					(decision) =>
						decision.kind === "connection" && decision.verdict !== "allowed",
				)
				.map((decision) => decision.reason),
		),
	];
	const configurationReasons = [
		...new Set(
			decisions
				.filter(
					(decision) =>
						decision.kind === "workspace_resource" &&
						decision.verdict !== "allowed",
				)
				.map((decision) => decision.reason),
		),
	];
	const status =
		blockingReasons.length > 0
			? "blocked"
			: configurationReasons.length > 0
				? "needs_configuration"
				: consentReasons.length > 0
					? "needs_consent"
					: "ready";
	return {
		blueprintId: input.blueprintId,
		revisionId: input.revisionId,
		revision: input.revision,
		status,
		instantiateAllowed:
			status !== "blocked" && status !== "needs_configuration",
		targetTediId,
		requirements,
		decisions,
		blockingReasons,
		consentReasons,
		configurationReasons,
		resolvedAt,
	};
}
