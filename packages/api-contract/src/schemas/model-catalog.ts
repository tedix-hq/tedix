/**
 * Shared cognition-layer provider / model catalog + per-turn override contract.
 *
 * BOTH cognition bodies resolve their LLM straight from worker env today: the
 * isolate (`apps/tedi-runtime/src/ai-sdk-adapter.ts → azureModel`) and the
 * kernel route planner (`apps/api/src/rpc/routers/kernel/llm.ts → kernelModel`)
 * each read `AZURE_*` and build an Azure provider. This module is the small,
 * SECRET-FREE seam they share: it SELECTS and VALIDATES which provider/model a
 * turn runs on; it never stores credentials (those stay in the environment).
 *
 * Design goals (all additive — the default path is byte-for-byte today's Azure
 * deployment):
 *
 *   1. A canonical `provider/model-id` model-ref shared by Agent-runtime and
 *      kernel model selection.
 *   2. A per-turn {@link ModelOverride} contract a caller MAY pass to pick a
 *      different catalog model — validated against an allowlist + the set of
 *      providers actually wired in this environment.
 *   3. {@link sanitizeModelOverride} applies provider-available and
 *      allow-predicate gates so an override that names an unconfigured provider
 *      or disallowed model degrades to `null` (caller falls back to its default)
 *      instead of pointing at a model the environment can't serve.
 *   4. {@link resolveModelSelection} returns the effective selection; with no
 *      override it returns the default ref unchanged.
 */

import * as z from "zod";

// =============================================================================
// PROVIDER + MODEL REF
// =============================================================================

/**
 * Providers the cognition layer can name in a model-ref. `azure-openai` is the
 * only one wired end-to-end today (isolate + kernel); the rest are declared so
 * the override contract / allowlist can reference them ahead of wiring without a
 * schema change. A ref naming an unwired provider simply fails the
 * `availableProviders` gate at resolution time.
 */
export const ModelProviderIdSchema = z.enum([
	"azure-openai",
	"google-vertex",
	"anthropic",
	"openai",
	// Cloudflare AI Gateway's adaptive model router. This is deliberately a
	// distinct provider identity: the concrete provider/model is selected at
	// request time and must not be mistaken for a fixed Workers AI model.
	"cloudflare",
	// Cloudflare Workers AI (serverless inference on the CF network). Billed to
	// Cloudflare credits (vs Azure credits for `azure-openai`); model ids are the
	// `@cf/...` slugs. Routed through the AI Gateway like the other providers.
	"workers-ai",
]);
export type ModelProviderId = z.infer<typeof ModelProviderIdSchema>;

/** Separator between the provider and model-id segments of a model-ref. */
export const MODEL_REF_SEPARATOR = "/";

/** Platform default for adaptive, policy-compatible inference. */
export const CLOUDFLARE_AUTO_MODEL_REF = "cloudflare/auto";

export interface ParsedModelRef {
	provider: ModelProviderId;
	/** Opaque model id — for Azure this is the DEPLOYMENT name, not a v1 model id. */
	modelId: string;
}

/**
 * Parse a `provider/model-id` ref. The first `/` splits provider from the
 * remainder; the provider segment must match {@link ModelProviderIdSchema} and
 * the model-id must be non-empty. Returns `null` for any malformed ref.
 */
export function parseModelRef(ref: string): ParsedModelRef | null {
	if (typeof ref !== "string") return null;
	const slash = ref.indexOf(MODEL_REF_SEPARATOR);
	if (slash <= 0) return null;
	const providerSegment = ref.slice(0, slash);
	const modelId = ref.slice(slash + 1).trim();
	if (!modelId) return null;
	const provider = ModelProviderIdSchema.safeParse(providerSegment);
	if (!provider.success) return null;
	return { provider: provider.data, modelId };
}

/** Build a canonical `provider/model-id` ref. */
export function buildModelRef(
	provider: ModelProviderId,
	modelId: string,
): string {
	return `${provider}${MODEL_REF_SEPARATOR}${modelId}`;
}

/** A `provider/model-id` ref whose provider is a known {@link ModelProviderId}. */
export const ModelRefSchema = z
	.string()
	.refine((ref) => parseModelRef(ref) !== null, {
		message:
			"model ref must be `<provider>/<model-id>` with a known provider segment",
	});

// =============================================================================
// CATALOG
// =============================================================================

/**
 * Whether a model accepts IMAGE input on the path this platform actually serves
 * it on. TRI-STATE on purpose: a boolean forces every model the catalog does not
 * describe into one of the two verdicts, and the safe-looking default
 * (`supported`) lets a composer attach an image that is then silently dropped —
 * the conversation wedges with no explanation. `unknown` is a first-class
 * verdict here, exactly as it is in the projection's filter chain: it means no
 * read in this repo backs a capability claim, and a caller must degrade (warn,
 * or refuse the attachment) rather than assume either way.
 */
export const ModelImageInputSupportSchema = z.enum([
	"supported",
	"unsupported",
	"unknown",
]);
export type ModelImageInputSupport = z.infer<
	typeof ModelImageInputSupportSchema
>;

/**
 * Lifecycle of a catalog reference.
 *
 * `superseded` is deliberately not "deleted": stored conversation, tedi, and
 * runtime-profile references must continue to resolve through the same
 * provider/policy gates. Lifecycle controls whether a ref is offered for a new
 * selection; it is not an inference authorization decision.
 */
export const ModelCatalogLifecycleSchema = z.enum(["active", "superseded"]);
export type ModelCatalogLifecycle = z.infer<typeof ModelCatalogLifecycleSchema>;

/** Governance facts that remain true independently of pricing or health. */
export const ModelWeightAccessSchema = z.enum([
	"open-weights",
	"closed-weights",
	"mixed",
]);
export type ModelWeightAccess = z.infer<typeof ModelWeightAccessSchema>;

export const ModelResidencyControlSchema = z.enum([
	"cloudflare-network",
	"customer-provider",
	"router-selected",
]);
export type ModelResidencyControl = z.infer<typeof ModelResidencyControlSchema>;

export const ModelRoutingModeSchema = z.enum(["fixed", "adaptive"]);
export type ModelRoutingMode = z.infer<typeof ModelRoutingModeSchema>;

export const ModelGovernanceSchema = z.object({
	weightAccess: ModelWeightAccessSchema,
	residencyControl: ModelResidencyControlSchema,
	routingMode: ModelRoutingModeSchema,
});
export type ModelGovernance = z.infer<typeof ModelGovernanceSchema>;

/**
 * Minimal catalog entry. This is only the cognition-layer selection surface:
 * the canonical ref plus the flags a planner/router needs to pick sensibly.
 */
export interface ModelCatalogEntry {
	ref: string;
	provider: ModelProviderId;
	modelId: string;
	label: string;
	reasoning: boolean;
	tier: "economy" | "balanced" | "frontier";
	/**
	 * Declared image-input capability. This is a claim about the SERVING PATH,
	 * not about the model's weights: a model that accepts images upstream but
	 * whose adapter here drops file parts is `unsupported`, because an image
	 * attached to that turn never reaches it.
	 */
	imageInput: ModelImageInputSupport;
	/** Typed sovereignty/reproducibility facts used by policy before execution. */
	governance: ModelGovernance;
	/**
	 * `active` refs may be offered for new selections. `superseded` refs remain
	 * resolvable for existing stored selections but must not appear in pickers or
	 * seed a new default.
	 */
	lifecycle: ModelCatalogLifecycle;
}

function azureEntry(
	modelId: string,
	label: string,
	reasoning: boolean,
	tier: ModelCatalogEntry["tier"],
	imageInput: ModelImageInputSupport,
	lifecycle: ModelCatalogLifecycle,
): ModelCatalogEntry {
	return {
		ref: buildModelRef("azure-openai", modelId),
		provider: "azure-openai",
		modelId,
		label,
		reasoning,
		tier,
		imageInput,
		governance: {
			weightAccess: "closed-weights",
			residencyControl: "customer-provider",
			routingMode: "fixed",
		},
		lifecycle,
	};
}

/**
 * Workers AI entries are `unsupported` for image input WITHOUT exception, and
 * that is an adapter fact rather than a per-model guess: `toWorkersAiMessages`
 * (`@tedix/workers-ai/model`, now the single implementation — both app copies
 * are gone) flattens a user turn's content to text and renders every non-text
 * part as the literal `[file]`, so no image reaches ANY `@cf/...` model on this
 * path.
 */
function workersAiEntry(
	modelId: string,
	label: string,
	reasoning: boolean,
	tier: ModelCatalogEntry["tier"],
	lifecycle: ModelCatalogLifecycle,
): ModelCatalogEntry {
	return {
		ref: buildModelRef("workers-ai", modelId),
		provider: "workers-ai",
		modelId,
		label,
		reasoning,
		tier,
		imageInput: "unsupported",
		governance: {
			weightAccess: "open-weights",
			residencyControl: "cloudflare-network",
			routingMode: "fixed",
		},
		lifecycle,
	};
}

function cloudflareAutoEntry(): ModelCatalogEntry {
	return {
		ref: buildModelRef("cloudflare", "auto"),
		provider: "cloudflare",
		modelId: "auto",
		label: "Auto",
		reasoning: true,
		tier: "balanced",
		imageInput: "supported",
		governance: {
			weightAccess: "mixed",
			residencyControl: "router-selected",
			routingMode: "adaptive",
		},
		lifecycle: "active",
	};
}

/**
 * The cognition-layer catalog. Azure deployment ids MUST match the Azure
 * resource's actual deployment names. The DEFAULT selection is never one of
 * these by id — it is whatever
 * `AZURE_CHAT_DEPLOYMENT` env names — so this list is the menu of EXPLICIT
 * overrides a caller may opt into, not a replacement for the env default.
 */
export const COGNITION_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
	// Deployment names verified in the Tedix Azure resource. Stored 5.6 pins
	// remain resolvable; superseded entries cannot be chosen for new work.
	azureEntry(
		"gpt-6.1-sol",
		"GPT-6.1 Sol",
		true,
		"balanced",
		"supported",
		"active",
	),
	azureEntry(
		"gpt-6-luna",
		"GPT-6 Luna",
		true,
		"economy",
		"supported",
		"active",
	),
	azureEntry(
		"gpt-6-astra",
		"GPT-6 Astra",
		true,
		"frontier",
		"supported",
		"active",
	),
	azureEntry(
		"gpt-6-sol",
		"GPT-6 Sol",
		true,
		"balanced",
		"supported",
		"superseded",
	),
	azureEntry(
		"gpt-5.6-sol",
		"GPT-5.6 Sol",
		true,
		"frontier",
		"supported",
		"superseded",
	),
	azureEntry(
		"gpt-5.6-terra",
		"GPT-5.6 Terra",
		true,
		"balanced",
		"supported",
		"superseded",
	),
	azureEntry(
		"gpt-5.6-luna",
		"GPT-5.6 Luna",
		true,
		"economy",
		"supported",
		"superseded",
	),
	// Cloudflare Workers AI (billed to Cloudflare credits). Full-power → cheapest.
	// All verified live through the AI Gateway; ids are current (non-deprecated).
	// Ordering follows an internal tool-calling bench (compliance with tools
	// present, multi-step round-trip, JSON mode, empty-turn rate); the small
	// llama entries are safe only on the tool-free routing path.
	workersAiEntry(
		"@cf/openai/gpt-oss-120b",
		"GPT-OSS 120B",
		true,
		"balanced",
		"active",
	),
	workersAiEntry(
		"@cf/moonshotai/kimi-k2.6",
		"Kimi K2.6",
		true,
		"frontier",
		"active",
	),
	workersAiEntry(
		"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		"Llama 3.3 70B",
		true,
		"balanced",
		"active",
	),
	workersAiEntry(
		"@cf/meta/llama-3.1-8b-instruct-fast",
		"Llama 3.1 8B Fast",
		false,
		"economy",
		"active",
	),
	workersAiEntry(
		"@cf/meta/llama-3.2-3b-instruct",
		"Llama 3.2 3B",
		false,
		"economy",
		"active",
	),
	workersAiEntry(
		"@cf/qwen/qwen2.5-coder-32b-instruct",
		"Qwen2.5 Coder 32B",
		false,
		"balanced",
		"active",
	),
	cloudflareAutoEntry(),
];

/** Find a catalog entry by its canonical ref. */
export function findCatalogEntry(ref: string): ModelCatalogEntry | undefined {
	return COGNITION_MODEL_CATALOG.find((entry) => entry.ref === ref);
}

/**
 * Declared image-input capability for a ref. A ref the catalog does not
 * describe — a typo, a retired deployment, a custom/org-configured model, or
 * the env default deployment (which is deliberately NOT allowlist-gated, see
 * {@link resolveModelSelection}) — resolves `unknown`, never a defaulted
 * `supported`. A caller MUST NOT collapse `unknown` into either verdict.
 */
export function resolveModelImageInput(ref: string): ModelImageInputSupport {
	return findCatalogEntry(ref)?.imageInput ?? "unknown";
}

/**
 * Providers the certified Agent runtime's chat adapter can actually serve. The
 * runtime can serve Azure, fixed Workers AI models, and the policy-gated
 * Cloudflare Auto Router. Auto Router still requires the per-request adaptive
 * routing context below; provider availability alone never admits it.
 *
 * This lives here rather than in the runtime so the model-catalog PROJECTION
 * can explain runtime compatibility from the SAME constant the runtime
 * enforces, instead of a second copy that can drift.
 */
export const AGENT_RUNTIME_AVAILABLE_PROVIDERS: ReadonlySet<ModelProviderId> =
	new Set<ModelProviderId>(["azure-openai", "workers-ai", "cloudflare"]);

// =============================================================================
// PER-TURN OVERRIDE CONTRACT
// =============================================================================

/**
 * A per-turn model override a caller MAY attach to a turn request. Validated
 * (allowlist + provider availability) before it can steer model selection; an
 * invalid override degrades to the default rather than the caller's choice.
 */
export const ModelOverrideSchema = z
	.object({
		modelRef: ModelRefSchema,
	})
	.strict();
export type ModelOverride = z.infer<typeof ModelOverrideSchema>;

/**
 * Explicit constraints on an already authorized model selection.
 * Tool authority is enforced independently; fixed-model and residency policy
 * prohibit adaptive inference regardless of the selected reference.
 */
export const AdaptiveRoutingContextSchema = z
	.object({
		surface: z.enum(["chat", "cron", "observer", "evaluation", "judgment"]),
		authority: z.enum(["ordinary", "authority-sensitive"]),
		reproducibility: z.enum(["adaptive", "fixed-model-required"]),
		sovereignty: z.enum(["unconstrained", "residency-bound"]),
	})
	.strict();
export type AdaptiveRoutingContext = z.infer<
	typeof AdaptiveRoutingContextSchema
>;

export function adaptiveRoutingEligible(
	context: AdaptiveRoutingContext | null | undefined,
): boolean {
	if (context == null) return true;
	const parsed = AdaptiveRoutingContextSchema.safeParse(context);
	return (
		parsed.success &&
		parsed.data.reproducibility === "adaptive" &&
		parsed.data.sovereignty === "unconstrained"
	);
}

export interface ModelAllowlistOptions {
	/**
	 * Providers actually wired in THIS environment (have credentials in env).
	 * A ref naming a provider outside this set is rejected — the catalog selects,
	 * but the environment must still be able to serve it.
	 */
	availableProviders: ReadonlySet<ModelProviderId>;
	/**
	 * Optional explicit ref allowlist. When provided, only these refs are
	 * resolvable (in addition to passing the provider-availability gate). When
	 * omitted, any catalog ref whose provider is available is allowed. Catalog
	 * lifecycle is deliberately not consulted: stored superseded refs still run.
	 */
	allowlist?: readonly string[];
}

/** Runtime/provider/policy resolution for an already-catalogued entry. */
export function isCatalogEntryResolvable(
	entry: ModelCatalogEntry,
	opts: ModelAllowlistOptions,
): boolean {
	if (!opts.availableProviders.has(entry.provider)) return false;
	if (opts.allowlist && !opts.allowlist.includes(entry.ref)) return false;
	return true;
}

/**
 * Allowlist gate for a single model-ref. The ref's provider must be AVAILABLE
 * in this environment AND the ref must pass the allow predicate (here: be in
 * the explicit allowlist, or any ref when no allowlist is configured). Also
 * requires the ref to exist in the catalog so a typo'd deployment can't slip
 * through.
 */
export function isModelRefAllowed(
	ref: string,
	opts: ModelAllowlistOptions,
): boolean {
	const parsed = parseModelRef(ref);
	if (!parsed) return false;
	const entry = findCatalogEntry(ref);
	if (!entry || entry.provider !== parsed.provider) return false;
	return isCatalogEntryResolvable(entry, opts);
}

/**
 * Sanitize a per-turn override against the allowlist. Returns the parsed
 * override when its `modelRef` passes {@link isModelRefAllowed}; otherwise
 * `null` (→ caller uses its default). An unserviceable or disallowed model
 * never overrides the default.
 */
export function sanitizeModelOverride(
	override: ModelOverride | { modelRef?: unknown } | null | undefined,
	opts: ModelAllowlistOptions,
): ModelOverride | null {
	const parsed = ModelOverrideSchema.safeParse(override);
	if (!parsed.success) return null;
	if (!isModelRefAllowed(parsed.data.modelRef, opts)) return null;
	return parsed.data;
}

// =============================================================================
// SELECTION
// =============================================================================

export interface ModelSelection {
	provider: ModelProviderId;
	modelId: string;
	ref: string;
	/** `"override"` when a valid override steered the choice, else `"default"`. */
	source: "default" | "override";
}

export interface ResolveModelSelectionOptions extends ModelAllowlistOptions {
	/**
	 * The environment default ref (e.g. `azure-openai/<AZURE_CHAT_DEPLOYMENT>`).
	 * This is NOT allowlist-gated — it is the trusted, env-configured fallback —
	 * but it MUST still be a well-formed ref.
	 */
	defaultRef: string;
	override?: ModelOverride | { modelRef?: unknown } | null;
}

/**
 * Resolve the effective model selection for a turn. With no (or an invalid)
 * override this returns the parsed `defaultRef` and `source: "default"` — the
 * behavior-preserving path. A valid, allowlisted override returns
 * `source: "override"`. Returns `null` only when `defaultRef` itself is
 * malformed (a programmer error the caller should treat as "no model").
 */
export function resolveModelSelection(
	opts: ResolveModelSelectionOptions,
): ModelSelection | null {
	const sanitized = sanitizeModelOverride(opts.override, opts);
	if (sanitized) {
		const parsed = parseModelRef(sanitized.modelRef);
		if (parsed) {
			return { ...parsed, ref: sanitized.modelRef, source: "override" };
		}
	}
	const fallback = parseModelRef(opts.defaultRef);
	if (!fallback) return null;
	return { ...fallback, ref: opts.defaultRef, source: "default" };
}
