/**
 * Model-catalog PROJECTION: the one contract-backed answer to "which models may
 * this caller route a turn at, and why".
 *
 * This module is a PROJECTION, never a second source of truth. It owns no
 * entitlement, policy, or credential state — every input is handed in by a
 * caller that read the canonical owner:
 *
 *   - provider wiring      → presence booleans over the serving Worker's env
 *                            (`Boolean(env.CF_AI_GATEWAY_TOKEN)`, never a value)
 *   - entitlement          → `getRuntimeEntitlement` + `runtimeEntitlementIsActive`
 *                            (the same helpers `authorizeRuntimeInference` reads)
 *   - org / tedi tiers     → `resolveAiGatewayAdmissionPolicy`, whose verdict this
 *                            module reproduces per-scope so a denial can name WHICH
 *                            scope denied (`aiGatewayModelTierAllowed` collapses both)
 *   - runtime compatibility→ `AGENT_RUNTIME_AVAILABLE_PROVIDERS`, the same constant
 *                            the certified Agent runtime's chat adapter enforces
 *   - caller authority     → `callerAuthorityModelRefs` input (currently unwired)
 *
 * SECRET-FREE by construction: {@link ModelCatalogEvaluationInput} cannot carry a
 * credential — provider wiring arrives as a `Set<ModelProviderId>` derived from
 * `Boolean(...)` presence checks. Nothing here reads env, D1, or a secret store.
 *
 * HONESTY RULES the shape enforces:
 *   - A denied model always carries the deciding check: the filter, a stable
 *     machine `reason`, a human `detail`, and the `input` (source path, whether it
 *     was configured, what it expected, what it observed). An empty or
 *     unexplained list is a defect, not an outcome.
 *   - "Not configured" is its own verdict — it never masquerades as `allow`. An
 *     unconfigured tier policy constrains nothing (matching the enforcer), and
 *     says so in `detail` rather than implying an operator chose it.
 *   - Provider health is `unknown`, not `allow`: the only breaker in the system is
 *     per-isolate and in-memory inside the Agent runtime, so no durable read backs
 *     a health claim from the control plane.
 *   - A filter with no input in scope (per-tedi tier with no tedi named) is ABSENT
 *     from the chain, never a passing check over a fabricated input.
 *   - A declared CAPABILITY (`imageInput`) is carried through verbatim from the
 *     catalog and is never folded into `allowed`: it does not admit or deny a
 *     model, it tells a composer what the model can be handed. Like the checks,
 *     it has an `unknown` verdict, and a model the catalog does not describe
 *     gets exactly that — never a defaulted `supported`.
 */

import * as z from "zod";
import {
	type ModelCatalogEntry,
	ModelGovernanceSchema,
	ModelImageInputSupportSchema,
	ModelCatalogLifecycleSchema,
	type ModelProviderId,
	ModelProviderIdSchema,
} from "./model-catalog";
import { AiGatewayModelTierSchema } from "./tedi";

// =============================================================================
// EXPLANATION SHAPE
// =============================================================================

/**
 * The filter chain, in evaluation order. Each id names the CANONICAL input it
 * reads, not a place this module stores state.
 */
export const ModelCatalogFilterSchema = z.enum([
	"provider_wired",
	"provider_health",
	"org_entitlement",
	"org_model_tier",
	"tedi_model_tier",
	"runtime_compatibility",
	"caller_authority",
]);
export type ModelCatalogFilter = z.infer<typeof ModelCatalogFilterSchema>;

/**
 * `deny` is the only verdict that removes a model. `not_configured` means the
 * input exists as a concept but no operator value is set — it constrains
 * nothing, and says so. `unknown` means no read backs a verdict at all.
 */
export const ModelCatalogVerdictSchema = z.enum([
	"allow",
	"deny",
	"not_configured",
	"unknown",
]);
export type ModelCatalogVerdict = z.infer<typeof ModelCatalogVerdictSchema>;

/**
 * The input a check consulted. `source` is the canonical read location so a
 * caller that gets a denial knows exactly what to change; `expected` /
 * `observed` are the two sides of the comparison actually made.
 */
export const ModelCatalogCheckInputSchema = z.object({
	source: z
		.string()
		.min(1)
		.describe(
			"Canonical location of the deciding input (D1 column path, env var, or shared constant) — never its secret value",
		),
	configured: z
		.boolean()
		.describe("Whether an operator value is actually set at `source`"),
	expected: z
		.array(z.string())
		.nullable()
		.describe(
			"The values `source` admits; null when the input is unset or carries no value set",
		),
	observed: z
		.string()
		.nullable()
		.describe("The model's value that was compared against `expected`"),
});
export type ModelCatalogCheckInput = z.infer<
	typeof ModelCatalogCheckInputSchema
>;

export const ModelCatalogCheckSchema = z.object({
	filter: ModelCatalogFilterSchema,
	verdict: ModelCatalogVerdictSchema,
	reason: z
		.string()
		.min(1)
		.describe("Stable snake_case code a caller can branch on"),
	detail: z
		.string()
		.min(1)
		.describe("Human-readable explanation of this verdict"),
	input: ModelCatalogCheckInputSchema,
});
export type ModelCatalogCheck = z.infer<typeof ModelCatalogCheckSchema>;

export const ModelCatalogModelSchema = z.object({
	ref: z.string().min(1),
	provider: ModelProviderIdSchema,
	modelId: z.string().min(1),
	label: z.string().min(1),
	reasoning: z.boolean(),
	tier: AiGatewayModelTierSchema,
	imageInput: ModelImageInputSupportSchema.describe(
		"Declared image-input capability, carried from the catalog entry. `unknown` means no read in the repo backs a claim either way — it is NOT permission to attach an image, and it never affects `allowed`.",
	),
	governance: ModelGovernanceSchema.describe(
		"Provider, weights, residency-control, and routing facts. Policy must treat router-selected or mixed values as non-sovereign unless it explicitly accepts them.",
	),
	lifecycle: ModelCatalogLifecycleSchema.describe(
		"Catalog lifecycle. Superseded refs remain resolvable for stored selections but are not offered for new selections.",
	),
	selectable: z
		.boolean()
		.describe(
			"Whether catalog lifecycle permits this ref to be offered for a new selection. This is independent of `allowed`, which reports provider, entitlement, policy, runtime, and caller authority.",
		),
	allowed: z
		.boolean()
		.describe("True when no check in `checks` returned verdict `deny`"),
	checks: z
		.array(ModelCatalogCheckSchema)
		.min(1)
		.describe(
			"The full filter chain evaluated for this model, in order. Filters with no input in scope are absent, never fabricated.",
		),
	deniedBy: ModelCatalogCheckSchema.nullable().describe(
		"The first denying check — the reason and the input to act on. Null when allowed.",
	),
});
export type ModelCatalogModel = z.infer<typeof ModelCatalogModelSchema>;

// =============================================================================
// SELECTION KINDS
// =============================================================================

/**
 * The five distinguishable ways a model gets chosen. They are NOT alternatives
 * to each other at the same layer: `org_default` is the floor, the two tedi
 * kinds compete for the chat slot (explicit beats inherited), `utility` covers
 * the non-chat slots, and `user_conversational` is a per-user override.
 */
export const ModelCatalogSelectionKindSchema = z.enum([
	"org_default",
	"tedi_inherited",
	"tedi_explicit",
	"user_conversational",
	"utility",
]);
export type ModelCatalogSelectionKind = z.infer<
	typeof ModelCatalogSelectionKindSchema
>;

/** The routing slot a selection steers. */
export const ModelCatalogSlotSchema = z.enum(["chat", "cron", "observer"]);
export type ModelCatalogSlot = z.infer<typeof ModelCatalogSlotSchema>;

export const ModelCatalogSelectionSchema = z.object({
	kind: ModelCatalogSelectionKindSchema,
	slot: ModelCatalogSlotSchema,
	scope: z
		.enum(["deployment", "organization", "tedi", "user"])
		.describe(
			"The blast radius of this selection. `deployment` means it is a Worker env value shared by every organization, not a per-org setting.",
		),
	status: z
		.enum(["set", "unset", "unsupported"])
		.describe(
			"`set`: an operator value resolves. `unset`: the input exists and is empty. `unsupported`: no store backs this selection kind in this build.",
		),
	modelRef: z
		.string()
		.nullable()
		.describe(
			"The selected ref. Null on a LIFECYCLE absence: `unset` (the input exists and no operator value resolves) or `unsupported` (no store backs this kind), which `status` and `detail` distinguish. Never null to mean a denial.",
		),
	source: z.string().min(1).describe("Canonical location of this selection"),
	detail: z.string().min(1),
	allowed: z
		.boolean()
		.nullable()
		.describe(
			"Whether this selection's ref survives the filter chain. Null on an AUTHORITY absence: no verdict was computed because there is no ref, or the ref is outside the cognition catalog and the chain never evaluated it — never null to mean allowed.",
		),
	selectable: z
		.boolean()
		.nullable()
		.describe(
			"Whether this selection's catalog lifecycle permits choosing it anew. Null when no catalog entry was resolved. A superseded ref may be allowed and routable while this is false.",
		),
	deniedBy: ModelCatalogCheckSchema.nullable().describe(
		"The deciding check when `allowed` is false. Null when the selection is allowed, and also when `allowed` is null (no verdict was computed) — read `allowed` first to tell those apart.",
	),
});
export type ModelCatalogSelection = z.infer<typeof ModelCatalogSelectionSchema>;

/** The effective routing answer for the interactive chat slot. */
export const ModelCatalogRoutingSchema = z.object({
	slot: ModelCatalogSlotSchema,
	modelRef: z
		.string()
		.nullable()
		.describe(
			"The ref chat turns actually route at. Null on a LIFECYCLE absence: no selection at any precedence layer resolves a ref (no tedi pin, no runtime profile ref, and no deployment default), which `detail` states.",
		),
	selectedBy: ModelCatalogSelectionKindSchema.nullable().describe(
		"Which selection kind won the precedence contest. Null exactly when `modelRef` is null — there was no winner to name.",
	),
	detail: z.string().min(1),
	allowed: z
		.boolean()
		.nullable()
		.describe(
			"Whether the routed ref survives the filter chain. Null on an AUTHORITY absence: no ref resolved, or the routed ref is outside the cognition catalog so the chain returned no verdict for it — never null to mean allowed.",
		),
	selectable: z
		.boolean()
		.nullable()
		.describe(
			"Whether the routed ref may be chosen anew. False does not invalidate this existing route; it means the catalog ref is superseded and pickers must not offer it.",
		),
	deniedBy: ModelCatalogCheckSchema.nullable().describe(
		"The deciding check when `allowed` is false — the reason chat turns are refused or degraded. Null when allowed, and when `allowed` is null (no verdict was computed).",
	),
});
export type ModelCatalogRouting = z.infer<typeof ModelCatalogRoutingSchema>;

export const ModelCatalogProjectionSchema = z.object({
	models: z.array(ModelCatalogModelSchema),
	selections: z.array(ModelCatalogSelectionSchema),
	routing: ModelCatalogRoutingSchema,
	wiredProviders: z
		.array(ModelProviderIdSchema)
		.describe(
			"Providers whose credentials/bindings are PRESENT in the serving Worker — derived from Boolean(...) presence checks, never from a secret value",
		),
});
export type ModelCatalogProjection = z.infer<
	typeof ModelCatalogProjectionSchema
>;

// =============================================================================
// EVALUATION INPUT
// =============================================================================

export type ModelCatalogTier = ModelCatalogEntry["tier"];

/** Entitlement admission state, exactly as the admission path computes it. */
export interface ModelCatalogEntitlementInput {
	/** False when `getRuntimeEntitlement` returned null. */
	configured: boolean;
	/** `runtimeEntitlementIsActive` over a trial/active status. */
	active: boolean;
	/** The row's status when configured; null otherwise. */
	status: string | null;
	/**
	 * The admission code this state produces — one of
	 * `entitlement_not_configured` / `entitlement_inactive` /
	 * `entitlement_period_inactive`, or null when admitted.
	 */
	code: string | null;
}

export interface ModelCatalogEvaluationInput {
	/**
	 * Providers the SERVING Worker can actually reach. Callers build this from
	 * `Boolean(env.X)` presence checks; a credential value must never reach here.
	 */
	wiredProviders: ReadonlySet<ModelProviderId>;
	entitlement: ModelCatalogEntitlementInput;
	/** Organization `billing_inference_policies.allowed_model_tiers`; null when unset. */
	orgAllowedTiers: readonly ModelCatalogTier[] | null;
	/** Set only when a tedi is in scope — otherwise the tedi filters are absent. */
	tedi: {
		/** Tedi `billing_inference_policies.allowed_model_tiers`; null when unset. */
		allowedTiers: readonly ModelCatalogTier[] | null;
		/** Providers the certified Agent runtime's chat adapter can serve. */
		runtimeProviders: ReadonlySet<ModelProviderId>;
	} | null;
	/**
	 * Per-caller model authority supplied by the projection caller. Null means
	 * NO caller-scoped model authority is wired in this build — the check reports
	 * `not_configured` rather than silently passing every model.
	 */
	callerAuthorityModelRefs: readonly string[] | null;
}

// =============================================================================
// SOURCES (canonical read locations, quoted in every explanation)
// =============================================================================

export const MODEL_CATALOG_SOURCES = {
	providerWired: "serving Worker env (presence booleans only)",
	providerHealth: "No durable provider-health signal configured",
	entitlement:
		"billing_accounts + billing_plan_versions (getRuntimeEntitlement)",
	orgTiers: "billing_inference_policies.organization.allowed_model_tiers",
	tediTiers: "billing_inference_policies.tedi.allowed_model_tiers",
	runtimeProviders:
		"@tedix/api-contract/schemas/model-catalog AGENT_RUNTIME_AVAILABLE_PROVIDERS",
	callerAuthority: "model-catalog projection input callerAuthorityModelRefs",
	orgDefault: "env.AZURE_CHAT_DEPLOYMENT (Worker var, deployment-scoped)",
	tediExplicit: "tedis.runtime_overrides.agents.defaults.model.primary",
	tediInherited: "runtime_profiles.config.modelPolicy.chatModelRef",
	utilityCron: "runtime_profiles.config.modelPolicy.cronModelRef",
	utilityObserver: "runtime_profiles.config.modelPolicy.observerModelRef",
	userConversational: "(no store)",
} as const;

/**
 * Stated in every org-tier explanation. The org-scope ceiling is READ by the
 * admission path but has no write path in the API today: the update contract's
 * `OrganizationMetadataSchema` does not list `aiGatewayPolicy` (zod strips it),
 * and `updateOrganizationMetadata` — the only helper typed to write it — has no
 * callers. Callers must not read "unset" as "an operator chose unrestricted".
 */
export const ORG_TIER_UNSETTABLE_NOTE =
	"NOTE: this input has no write path in the API today — UpdateOrganizationInputSchema's OrganizationMetadataSchema omits `aiGatewayPolicy` (zod strips it) and packages/db updateOrganizationMetadata has no callers — so `unset` here means UNSETTABLE, not an operator decision.";

// =============================================================================
// ENGINE
// =============================================================================

function tierList(tiers: readonly ModelCatalogTier[]): string {
	return tiers.join(", ");
}

function providerWiredCheck(
	entry: ModelCatalogEntry,
	wired: ReadonlySet<ModelProviderId>,
): ModelCatalogCheck {
	const expected = [...wired].sort();
	const input: ModelCatalogCheckInput = {
		source: MODEL_CATALOG_SOURCES.providerWired,
		configured: wired.size > 0,
		expected: expected.length > 0 ? expected : null,
		observed: entry.provider,
	};
	if (wired.has(entry.provider)) {
		return {
			filter: "provider_wired",
			verdict: "allow",
			reason: "provider_wired",
			detail: `Provider \`${entry.provider}\` has credentials/bindings present in the serving Worker.`,
			input,
		};
	}
	return {
		filter: "provider_wired",
		verdict: "deny",
		reason: "provider_not_wired",
		detail:
			expected.length > 0
				? `Provider \`${entry.provider}\` is not wired in the serving Worker; wired providers are: ${expected.join(", ")}.`
				: `Provider \`${entry.provider}\` is not wired: the serving Worker has no model provider credentials or bindings at all.`,
		input,
	};
}

/**
 * Provider health is deliberately `unknown`: no durable provider-health
 * observation is configured, so returning `allow` has no supporting read.
 */
function providerHealthCheck(entry: ModelCatalogEntry): ModelCatalogCheck {
	return {
		filter: "provider_health",
		verdict: "unknown",
		reason: "provider_health_not_observed",
		detail:
			"No durable provider-health observation is configured, so health is UNKNOWN here.",
		input: {
			source: MODEL_CATALOG_SOURCES.providerHealth,
			configured: false,
			expected: null,
			observed: entry.provider,
		},
	};
}

function entitlementCheck(
	entitlement: ModelCatalogEntitlementInput,
): ModelCatalogCheck {
	const input: ModelCatalogCheckInput = {
		source: MODEL_CATALOG_SOURCES.entitlement,
		configured: entitlement.configured,
		expected: ["trial", "active"],
		observed: entitlement.status,
	};
	if (!entitlement.configured) {
		return {
			filter: "org_entitlement",
			verdict: "deny",
			reason: "entitlement_not_configured",
			detail:
				"The organization has no runtime entitlement, so the admission path refuses EVERY inference call regardless of model. Configure a billing account / plan version for this organization.",
			input,
		};
	}
	if (!entitlement.active) {
		return {
			filter: "org_entitlement",
			verdict: "deny",
			reason: entitlement.code ?? "entitlement_inactive",
			detail: `The organization's runtime entitlement is not admitting inference (status \`${entitlement.status ?? "unknown"}\`), so every model is denied until it is restored.`,
			input,
		};
	}
	return {
		filter: "org_entitlement",
		verdict: "allow",
		reason: "entitlement_active",
		detail: `The organization's runtime entitlement admits inference (status \`${entitlement.status ?? "unknown"}\`).`,
		input,
	};
}

function tierCheck(
	filter: "org_model_tier" | "tedi_model_tier",
	source: string,
	tiers: readonly ModelCatalogTier[] | null,
	entry: ModelCatalogEntry,
	unsettableNote: string | null,
): ModelCatalogCheck {
	const scopeLabel = filter === "org_model_tier" ? "Organization" : "Tedi";
	const input: ModelCatalogCheckInput = {
		source,
		configured: tiers !== null,
		expected: tiers === null ? null : [...tiers],
		observed: entry.tier,
	};
	if (tiers === null) {
		return {
			filter,
			verdict: "not_configured",
			reason: `${filter}_not_configured`,
			detail: `${scopeLabel} model-tier policy is not set, so it constrains nothing — this is the enforcer's own behaviour (an unconstrained scope admits every tier), not an operator allowlisting \`${entry.tier}\`.${unsettableNote ? ` ${unsettableNote}` : ""}`,
			input,
		};
	}
	if (tiers.includes(entry.tier)) {
		return {
			filter,
			verdict: "allow",
			reason: `${filter}_allowed`,
			detail: `${scopeLabel} model-tier policy admits tier \`${entry.tier}\` (allowed: ${tierList(tiers)}).`,
			input,
		};
	}
	return {
		filter,
		verdict: "deny",
		reason: "model_tier_not_allowed",
		detail: `${scopeLabel} model-tier policy denies tier \`${entry.tier}\`; it admits only ${tierList(tiers)}. Widen ${source} or pick a model in an admitted tier.`,
		input,
	};
}

function runtimeCompatibilityCheck(
	entry: ModelCatalogEntry,
	runtimeProviders: ReadonlySet<ModelProviderId>,
): ModelCatalogCheck {
	const expected = [...runtimeProviders].sort();
	const input: ModelCatalogCheckInput = {
		source: MODEL_CATALOG_SOURCES.runtimeProviders,
		configured: true,
		expected,
		observed: entry.provider,
	};
	if (runtimeProviders.has(entry.provider)) {
		return {
			filter: "runtime_compatibility",
			verdict: "allow",
			reason: "runtime_provider_supported",
			detail: `The certified Agent runtime's chat adapter can serve provider \`${entry.provider}\`.`,
			input,
		};
	}
	return {
		filter: "runtime_compatibility",
		verdict: "deny",
		reason: "runtime_provider_unsupported",
		detail: `The certified Agent runtime's chat adapter serves only ${expected.join(", ")}; a \`${entry.provider}\` ref pinned on this tedi is discarded at selection time and the turn silently falls back to the env default deployment.`,
		input,
	};
}

function callerAuthorityCheck(
	entry: ModelCatalogEntry,
	modelRefs: readonly string[] | null,
): ModelCatalogCheck {
	const input: ModelCatalogCheckInput = {
		source: MODEL_CATALOG_SOURCES.callerAuthority,
		configured: modelRefs !== null,
		expected: modelRefs === null ? null : [...modelRefs],
		observed: entry.ref,
	};
	if (modelRefs === null) {
		return {
			filter: "caller_authority",
			verdict: "not_configured",
			reason: "caller_authority_not_configured",
			detail:
				"No caller-scoped model grant source is wired in this build. The API supplies a null callerAuthorityModelRefs input; access is governed by the procedure’s two-plane guard, with no per-model caller grant.",
			input,
		};
	}
	if (modelRefs.includes(entry.ref)) {
		return {
			filter: "caller_authority",
			verdict: "allow",
			reason: "caller_authority_granted",
			detail: `The caller's model authority names \`${entry.ref}\`.`,
			input,
		};
	}
	return {
		filter: "caller_authority",
		verdict: "deny",
		reason: "caller_authority_missing",
		detail: `The caller's model authority does not name \`${entry.ref}\`; it grants only ${modelRefs.length} ref(s).`,
		input,
	};
}

/**
 * Evaluate the full filter chain for one catalog entry. Chain order is fixed:
 * provider wiring → provider health → org entitlement → org tier → tedi tier →
 * runtime compatibility → caller authority. Every check is recorded; `deniedBy`
 * is the FIRST `deny`, and `allowed` is true only when no check denied.
 */
export function evaluateModelCatalogEntry(
	entry: ModelCatalogEntry,
	input: ModelCatalogEvaluationInput,
): ModelCatalogModel {
	const checks: ModelCatalogCheck[] = [
		providerWiredCheck(entry, input.wiredProviders),
		providerHealthCheck(entry),
		entitlementCheck(input.entitlement),
		tierCheck(
			"org_model_tier",
			MODEL_CATALOG_SOURCES.orgTiers,
			input.orgAllowedTiers,
			entry,
			ORG_TIER_UNSETTABLE_NOTE,
		),
	];
	// Per-tedi filters are ABSENT when no tedi is in scope — never a passing
	// check over an input that was not read.
	if (input.tedi) {
		checks.push(
			tierCheck(
				"tedi_model_tier",
				MODEL_CATALOG_SOURCES.tediTiers,
				input.tedi.allowedTiers,
				entry,
				null,
			),
			runtimeCompatibilityCheck(entry, input.tedi.runtimeProviders),
		);
	}
	checks.push(callerAuthorityCheck(entry, input.callerAuthorityModelRefs));

	const deniedBy = checks.find((check) => check.verdict === "deny") ?? null;
	return {
		ref: entry.ref,
		provider: entry.provider,
		modelId: entry.modelId,
		label: entry.label,
		reasoning: entry.reasoning,
		tier: entry.tier,
		imageInput: entry.imageInput,
		governance: entry.governance,
		lifecycle: entry.lifecycle,
		selectable: entry.lifecycle === "active",
		allowed: deniedBy === null,
		checks,
		deniedBy,
	};
}

/** Evaluate the whole catalog. Order follows the catalog's own declaration. */
export function evaluateModelCatalog(
	entries: readonly ModelCatalogEntry[],
	input: ModelCatalogEvaluationInput,
): ModelCatalogModel[] {
	return entries.map((entry) => evaluateModelCatalogEntry(entry, input));
}
