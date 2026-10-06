/**
 * Model-catalog projection service: read the CANONICAL inputs, hand them to the
 * pure engine, and shape the selections.
 *
 * Every read below is the same helper the enforcing path uses — this service
 * owns no entitlement, policy, or model state of its own:
 *
 *   entitlement  → getRuntimeEntitlement + runtimeEntitlementIsActive
 *                  (authorizeRuntimeInference reads exactly these)
 *   tier policy  → getEffectiveInferencePolicies + resolveAiGatewayAdmissionPolicy
 *   tedi pin     → chatModelRefFromRuntimeOverrides (what tedis.getModelPolicy returns)
 *   profile      → getRuntimeProfileById → config.modelPolicy
 *   runtime      → AGENT_RUNTIME_AVAILABLE_PROVIDERS (the runtime's own constant)
 *
 * SECRETS: provider wiring is projected as presence booleans only. No env value
 * is copied into the response, and the resolved-tedi-config path
 * (`apps/tedi/src/resolve.ts`, which merges plaintext provider keys into the
 * same object as `runtimeProfileConfig`) is deliberately NOT used as a source.
 */

import {
	AGENT_RUNTIME_AVAILABLE_PROVIDERS,
	buildModelRef,
	CLOUDFLARE_AUTO_MODEL_REF,
	COGNITION_MODEL_CATALOG,
	type ModelProviderId,
} from "@tedix/api-contract/schemas/model-catalog";
import {
	evaluateModelCatalog,
	MODEL_CATALOG_SOURCES,
	type ModelCatalogEntitlementInput,
	type ModelCatalogModel,
	type ModelCatalogProjection,
	type ModelCatalogRouting,
	type ModelCatalogSelection,
	type ModelCatalogTier,
} from "@tedix/api-contract/schemas/model-catalog-projection";
import type { DbClient } from "@tedix/db/client";
import { getEffectiveInferencePolicies } from "@tedix/db/queries/billing/inference-policies";
import { getRuntimeProfileById } from "@tedix/db/queries/control-plane/definitions";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";
import type { ModelPolicy } from "@tedix/db/schema/control-plane";
import type { Tedi } from "@tedix/db/schema/tedis";
import {
	chatModelRefFromRuntimeOverrides,
	rawChatModelOverride,
} from "../lib/tedi-model-overrides";
import { resolveAiGatewayAdmissionPolicy } from "./ai-gateway-admission-policy";

/**
 * Env fields the projection reads. Every one is a Worker `var` (public in
 * `wrangler.jsonc`) except the two gateway credentials, which are read ONLY
 * through `Boolean(...)` — their values never leave this function.
 */
export interface ModelCatalogEnv {
	AI?: unknown;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_LLM_ID?: string;
	CF_AI_GATEWAY_TOKEN?: string;
	AZURE_OPENAI_RESOURCE?: string;
	AZURE_OPENAI_BASE_URL?: string;
	AZURE_CHAT_DEPLOYMENT?: string;
}

/**
 * Which providers the SERVING Worker can actually reach, derived from presence
 * checks only. The Azure predicate mirrors `kernelModel()`'s own bail-outs
 * (authenticated gateway BYOK + a resource/base URL + a deployment); Workers AI
 * needs only the `AI` binding. `google-vertex` / `anthropic` / `openai` are
 * declared in the provider enum but wired nowhere, so they are never present.
 */
export function wiredProviders(
	env: ModelCatalogEnv,
): ReadonlySet<ModelProviderId> {
	const wired = new Set<ModelProviderId>();
	const gatewayByok = Boolean(
		env.AI_GATEWAY_ACCOUNT_ID?.trim() &&
		env.AI_GATEWAY_LLM_ID?.trim() &&
		env.CF_AI_GATEWAY_TOKEN?.trim(),
	);
	const azureEndpoint = Boolean(
		env.AZURE_OPENAI_RESOURCE?.trim() || env.AZURE_OPENAI_BASE_URL?.trim(),
	);
	if (
		gatewayByok &&
		azureEndpoint &&
		Boolean(env.AZURE_CHAT_DEPLOYMENT?.trim())
	) {
		wired.add("azure-openai");
	}
	if (env.AI) wired.add("workers-ai");
	if (gatewayByok) wired.add("cloudflare");
	return wired;
}

function allowedTiers(
	policy: { allowedModelTiers?: readonly ModelCatalogTier[] } | undefined,
): readonly ModelCatalogTier[] | null {
	return policy?.allowedModelTiers ?? null;
}

function entitlementInput(
	entitlement: Awaited<ReturnType<typeof getRuntimeEntitlement>>,
	nowMs: number,
): ModelCatalogEntitlementInput {
	if (!entitlement) {
		return {
			configured: false,
			active: false,
			status: null,
			code: "entitlement_not_configured",
		};
	}
	// The admission path's exact ladder: a non-trial/active status is
	// `entitlement_inactive`, and a lapsed effective period on an otherwise
	// admitting status is `entitlement_period_inactive`.
	if (entitlement.status !== "trial" && entitlement.status !== "active") {
		return {
			configured: true,
			active: false,
			status: entitlement.status,
			code: "entitlement_inactive",
		};
	}
	if (!runtimeEntitlementIsActive(entitlement, nowMs)) {
		return {
			configured: true,
			active: false,
			status: entitlement.status,
			code: "entitlement_period_inactive",
		};
	}
	return {
		configured: true,
		active: true,
		status: entitlement.status,
		code: null,
	};
}

function verdictFor(
	models: readonly ModelCatalogModel[],
	ref: string | null,
): Pick<ModelCatalogSelection, "allowed" | "selectable" | "deniedBy"> {
	if (!ref) return { allowed: null, selectable: null, deniedBy: null };
	const model = models.find((candidate) => candidate.ref === ref);
	// A ref that is not in the catalog cannot be evaluated by the chain. It is
	// reported as `allowed: null` (no verdict), never `false` (a denial we did
	// not make) — the selection's own `detail` carries why.
	if (!model) return { allowed: null, selectable: null, deniedBy: null };
	return {
		allowed: model.allowed,
		selectable: model.selectable,
		deniedBy: model.deniedBy,
	};
}

export interface ModelCatalogProjectionInput {
	db: DbClient;
	env: ModelCatalogEnv;
	/**
	 * Organization the projection is scoped to. When a tedi is in scope this is
	 * the TEDI's organization — the entitlement and org policy that actually gate
	 * its inference — which a platform-admin cross-org read must not confuse with
	 * the caller's own org.
	 */
	organizationId: string;
	/** Already authorized by the caller (requireTediAccess). */
	tedi: Tedi | null;
	includeDenied: boolean;
	nowMs?: number;
}

export async function buildModelCatalogProjection(
	input: ModelCatalogProjectionInput,
): Promise<ModelCatalogProjection> {
	const nowMs = input.nowMs ?? Date.now();
	const [entitlement, policySources] = await Promise.all([
		getRuntimeEntitlement(input.db, input.organizationId),
		getEffectiveInferencePolicies(
			input.db,
			input.organizationId,
			input.tedi?.id ?? null,
		),
	]);
	const policy = policySources
		? resolveAiGatewayAdmissionPolicy(policySources)
		: {};

	const wired = wiredProviders(input.env);
	const evaluated = evaluateModelCatalog(COGNITION_MODEL_CATALOG, {
		wiredProviders: wired,
		entitlement: entitlementInput(entitlement, nowMs),
		orgAllowedTiers: allowedTiers(policy.organization),
		tedi: input.tedi
			? {
					allowedTiers: allowedTiers(policy.tedi),
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				}
			: null,
		// No caller-scoped model grant source is wired here. The procedure’s
		// two-plane guard owns access; it does not supply per-model caller grants.
		// Null → the check reports `not_configured` instead of silently allowing
		// every ref.
		callerAuthorityModelRefs: null,
	});

	const selections = await buildSelections({
		db: input.db,
		env: input.env,
		tedi: input.tedi,
		models: evaluated,
	});

	return {
		models: input.includeDenied
			? evaluated
			: evaluated.filter((model) => model.allowed),
		selections,
		routing: buildRouting(selections, evaluated, input.env),
		wiredProviders: [...wired].sort(),
	};
}

async function buildSelections(args: {
	db: DbClient;
	env: ModelCatalogEnv;
	tedi: Tedi | null;
	models: readonly ModelCatalogModel[];
}): Promise<ModelCatalogSelection[]> {
	const selections: ModelCatalogSelection[] = [];

	// ── org default ──────────────────────────────────────────────────────────
	// There is NO organization-scoped default model ref in D1: the effective
	// default is the serving Worker's `AZURE_CHAT_DEPLOYMENT` var, which is a
	// DEPLOYMENT value shared by every organization (and differs between the API
	// Worker and the Agent runtime Worker). Reported with `scope: "deployment"`
	// so a caller cannot mistake it for an org setting.
	const deployment = args.env.AZURE_CHAT_DEPLOYMENT?.trim();
	const orgDefaultRef = CLOUDFLARE_AUTO_MODEL_REF;
	selections.push({
		kind: "org_default",
		slot: "chat",
		scope: "deployment",
		status: "set",
		modelRef: orgDefaultRef,
		source: MODEL_CATALOG_SOURCES.orgDefault,
		detail: `Cloudflare Auto Router is the platform default for compatible ordinary inference. Governed exceptions fall back to the fixed deployment${deployment ? ` azure-openai/${deployment}` : " configured by the serving runtime"}.`,
		...verdictFor(args.models, orgDefaultRef),
	});

	// ── user conversational preference ───────────────────────────────────────
	// Structurally absent: no user-preference store is read by any model
	// selection path. `user_configs` exists in D1 but has no caller, no contract,
	// and no model namespace/key convention, and kernel/Home conversations
	// resolve their model from `KERNEL_MODEL_REF` (a Worker var), not a user row.
	selections.push({
		kind: "user_conversational",
		slot: "chat",
		scope: "user",
		status: "unsupported",
		modelRef: null,
		source: MODEL_CATALOG_SOURCES.userConversational,
		detail:
			"No per-user conversational model preference is stored or read anywhere in this build. Kernel/Home turns resolve their model from the KERNEL_MODEL_REF Worker var, not from a user row, so this selection is UNSUPPORTED rather than unset.",
		allowed: null,
		selectable: null,
		deniedBy: null,
	});

	if (!args.tedi) return selections;

	// ── tedi explicit ────────────────────────────────────────────────────────
	const explicitRef = chatModelRefFromRuntimeOverrides(
		args.tedi.runtimeOverrides,
	);
	const rawOverride = rawChatModelOverride(args.tedi.runtimeOverrides);
	selections.push({
		kind: "tedi_explicit",
		slot: "chat",
		scope: "tedi",
		status: explicitRef ? "set" : "unset",
		modelRef: explicitRef,
		source: MODEL_CATALOG_SOURCES.tediExplicit,
		detail: explicitRef
			? "A whole-tedi model pin. It beats the runtime profile and forces the cron and observer slots to fall back onto it."
			: rawOverride
				? `A model pin is STORED (\`${rawOverride}\`) but does not name a catalog model, so it is discarded at selection time and the tedi silently falls back to its runtime profile or the env default. Repin using a ref from \`models\`.`
				: "No per-tedi model pin is set; selection falls through to the runtime profile.",
		...verdictFor(args.models, explicitRef),
	});

	// ── tedi inherited + utility slots ───────────────────────────────────────
	const modelPolicy = await resolveProfileModelPolicy(args.db, args.tedi);
	const inheritedRef =
		modelPolicy.authorized && modelPolicy.resolved
			? (policyRef(modelPolicy.policy?.chatModelRef) ??
				CLOUDFLARE_AUTO_MODEL_REF)
			: null;
	selections.push({
		kind: "tedi_inherited",
		slot: "chat",
		scope: "tedi",
		status: inheritedRef ? "set" : "unset",
		modelRef: inheritedRef,
		source: MODEL_CATALOG_SOURCES.tediInherited,
		detail: inheritedRef
			? `Inherited from the tedi's runtime profile. ${explicitRef ? "It is OVERRIDDEN by the per-tedi pin above." : "It steers the chat slot unless a per-tedi pin is set."}`
			: modelPolicy.detail,
		...verdictFor(args.models, inheritedRef),
	});

	const cronRef =
		explicitRef ??
		(modelPolicy.authorized && modelPolicy.resolved
			? (policyRef(modelPolicy.policy?.cronModelRef) ??
				CLOUDFLARE_AUTO_MODEL_REF)
			: null);
	selections.push({
		kind: "utility",
		slot: "cron",
		scope: "tedi",
		status: cronRef ? "set" : "unset",
		modelRef: cronRef,
		source: explicitRef
			? MODEL_CATALOG_SOURCES.tediExplicit
			: MODEL_CATALOG_SOURCES.utilityCron,
		detail: explicitRef
			? "Scheduled turns follow the per-tedi pin: an explicit pin returns null surface refs, so every slot resolves onto it."
			: cronRef
				? "Scheduled (cron / trusted-scheduler) turns run this model; absent it falls back to the chat ref."
				: "No cron model ref is set; scheduled turns fall back to the chat ref.",
		...verdictFor(args.models, cronRef),
	});

	const observerRef =
		explicitRef ??
		(modelPolicy.authorized && modelPolicy.resolved
			? (policyRef(modelPolicy.policy?.observerModelRef) ??
				CLOUDFLARE_AUTO_MODEL_REF)
			: null);
	selections.push({
		kind: "utility",
		slot: "observer",
		scope: "tedi",
		status: observerRef ? "set" : "unset",
		modelRef: observerRef,
		source: MODEL_CATALOG_SOURCES.utilityObserver,
		detail: observerRef
			? "The post-turn observer/reflector runs this model."
			: "No observer model ref is set. The observer deliberately does NOT inherit the chat ref — it falls back to the Agent runtime Worker's own observer env deployment, which this control-plane read cannot see.",
		...verdictFor(args.models, observerRef),
	});

	return selections;
}

/** Non-empty string, else `null` — the shape the runtime consumes. */
function policyRef(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read the tedi's runtime profile model policy with an explicit OWNERSHIP
 * predicate. `runtime_profiles.organization_id` is nullable, so a row is only
 * usable here when it is genuinely ownerless (NULL) or owned by this tedi's
 * organization — a `scope: "system"` row is NOT assumed ownerless, because a
 * system-scoped row can still carry an owning organization.
 */
async function resolveProfileModelPolicy(
	db: DbClient,
	tedi: Tedi,
): Promise<{
	policy: ModelPolicy | undefined;
	detail: string;
	authorized: boolean;
	resolved: boolean;
}> {
	if (!tedi.runtimeProfileId) {
		return {
			policy: undefined,
			authorized: true,
			resolved: false,
			detail:
				"The tedi is not bound to a runtime profile, so no inherited model ref exists.",
		};
	}
	const profile = await getRuntimeProfileById(db, tedi.runtimeProfileId);
	if (!profile) {
		return {
			policy: undefined,
			authorized: true,
			resolved: false,
			detail: `The tedi's runtime_profile_id (\`${tedi.runtimeProfileId}\`) does not resolve to a row, so no inherited model ref exists.`,
		};
	}
	if (
		profile.organizationId !== null &&
		profile.organizationId !== tedi.organizationId
	) {
		return {
			policy: undefined,
			authorized: false,
			resolved: false,
			detail: `The tedi's runtime profile is owned by a different organization (\`${profile.organizationId}\`); its model policy is not projected across the tenant boundary.`,
		};
	}
	const policy = profile.config?.modelPolicy as ModelPolicy | undefined;
	return {
		policy,
		authorized: true,
		resolved: true,
		detail: policy
			? "The tedi's runtime profile carries no chat model ref, so the chat slot falls back to the env default."
			: "The tedi's runtime profile carries no modelPolicy, so the chat slot falls back to the env default.",
	};
}

/**
 * The effective routing explanation for the chat slot. Precedence is exactly
 * `tedis.getModelPolicy`'s: per-tedi pin, then runtime profile, then the env
 * default deployment. The per-user preference kind never participates because
 * nothing stores it.
 */
function buildRouting(
	selections: readonly ModelCatalogSelection[],
	models: readonly ModelCatalogModel[],
	env: ModelCatalogEnv,
): ModelCatalogRouting {
	const chat = selections.filter((selection) => selection.slot === "chat");
	const byKind = (kind: ModelCatalogSelection["kind"]) =>
		chat.find((selection) => selection.kind === kind) ?? null;

	const winner =
		[byKind("tedi_explicit"), byKind("tedi_inherited"), byKind("org_default")]
			.filter((selection): selection is ModelCatalogSelection =>
				Boolean(selection),
			)
			.find((selection) => selection.modelRef !== null) ?? null;

	if (!winner || !winner.modelRef) {
		return {
			slot: "chat",
			modelRef: null,
			selectedBy: null,
			detail: env.AZURE_CHAT_DEPLOYMENT?.trim()
				? "No selection resolves a chat model ref."
				: "No chat model ref resolves at any layer: no per-tedi pin, no runtime profile ref, and the serving Worker has no AZURE_CHAT_DEPLOYMENT default.",
			allowed: null,
			selectable: null,
			deniedBy: null,
		};
	}

	const verdict = verdictFor(models, winner.modelRef);
	const inCatalog = models.some((model) => model.ref === winner.modelRef);
	const precedence =
		winner.kind === "tedi_explicit"
			? "the per-tedi pin (highest precedence)"
			: winner.kind === "tedi_inherited"
				? "the tedi's runtime profile (no per-tedi pin is set)"
				: "the serving Worker's deployment default (no tedi-scoped selection is set)";
	return {
		slot: "chat",
		modelRef: winner.modelRef,
		selectedBy: winner.kind,
		detail: inCatalog
			? `Chat turns route at \`${winner.modelRef}\`, selected by ${precedence}.${
					verdict.deniedBy
						? ` The filter chain DENIES this ref (${verdict.deniedBy.reason}), so the turn is refused or degrades rather than running it.`
						: ""
				}`
			: `Chat turns route at \`${winner.modelRef}\`, selected by ${precedence}. This ref is NOT in the cognition catalog, so the filter chain returns no verdict for it.`,
		...verdict,
	};
}
