import { describe, expect, it } from "vite-plus/test";
import {
	AGENT_RUNTIME_AVAILABLE_PROVIDERS,
	COGNITION_MODEL_CATALOG,
	type ModelCatalogEntry,
	type ModelProviderId,
} from "./model-catalog";
import {
	evaluateModelCatalog,
	evaluateModelCatalogEntry,
	type ModelCatalogCheck,
	type ModelCatalogEvaluationInput,
	type ModelCatalogFilter,
	ModelCatalogModelSchema,
	ORG_TIER_UNSETTABLE_NOTE,
} from "./model-catalog-projection";

const ALL_PROVIDERS: ReadonlySet<ModelProviderId> = new Set([
	"azure-openai",
	"workers-ai",
	"cloudflare",
]);

const AZURE_FRONTIER = COGNITION_MODEL_CATALOG.find(
	(entry) => entry.provider === "azure-openai" && entry.tier === "frontier",
) as ModelCatalogEntry;
const WORKERS_ECONOMY = COGNITION_MODEL_CATALOG.find(
	(entry) => entry.provider === "workers-ai" && entry.tier === "economy",
) as ModelCatalogEntry;

function input(
	overrides: Partial<ModelCatalogEvaluationInput> = {},
): ModelCatalogEvaluationInput {
	return {
		wiredProviders: ALL_PROVIDERS,
		entitlement: {
			configured: true,
			active: true,
			status: "active",
			code: null,
		},
		orgAllowedTiers: null,
		tedi: null,
		callerAuthorityModelRefs: null,
		...overrides,
	};
}

function check(
	checks: readonly ModelCatalogCheck[],
	filter: ModelCatalogFilter,
): ModelCatalogCheck | undefined {
	return checks.find((entry) => entry.filter === filter);
}

describe("model-catalog projection — shape guarantees", () => {
	it("returns every catalog entry with a non-empty ordered filter chain", () => {
		const models = evaluateModelCatalog(COGNITION_MODEL_CATALOG, input());
		expect(models).toHaveLength(COGNITION_MODEL_CATALOG.length);
		for (const model of models) {
			expect(ModelCatalogModelSchema.parse(model)).toBeTruthy();
			expect(model.lifecycle).toBe(
				COGNITION_MODEL_CATALOG.find((entry) => entry.ref === model.ref)
					?.lifecycle ?? "active",
			);
			expect(model.selectable).toBe(model.lifecycle === "active");
			expect(model.checks.map((entry) => entry.filter)).toEqual([
				"provider_wired",
				"provider_health",
				"org_entitlement",
				"org_model_tier",
				"caller_authority",
			]);
		}
	});

	it("keeps superseded refs resolvable while excluding them from new selections", () => {
		const superseded: ModelCatalogEntry = {
			...AZURE_FRONTIER,
			lifecycle: "superseded",
		};
		const model = evaluateModelCatalogEntry(superseded, input());
		expect(model.allowed).toBe(true);
		expect(model.deniedBy).toBeNull();
		expect(model.lifecycle).toBe("superseded");
		expect(model.selectable).toBe(false);
		expect(ModelCatalogModelSchema.parse(model)).toEqual(model);
	});

	it("inserts the per-tedi filters, in order, only when a tedi is in scope", () => {
		const model = evaluateModelCatalogEntry(
			AZURE_FRONTIER,
			input({
				tedi: {
					allowedTiers: null,
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				},
			}),
		);
		expect(model.checks.map((entry) => entry.filter)).toEqual([
			"provider_wired",
			"provider_health",
			"org_entitlement",
			"org_model_tier",
			"tedi_model_tier",
			"runtime_compatibility",
			"caller_authority",
		]);
	});

	it("omits the per-tedi filters entirely rather than passing them over an unread input", () => {
		const model = evaluateModelCatalogEntry(AZURE_FRONTIER, input());
		expect(check(model.checks, "tedi_model_tier")).toBeUndefined();
		expect(check(model.checks, "runtime_compatibility")).toBeUndefined();
	});

	it("every denied model carries the deciding filter, reason and input", () => {
		const models = evaluateModelCatalog(
			COGNITION_MODEL_CATALOG,
			input({ orgAllowedTiers: ["frontier"] }),
		);
		const denied = models.filter((model) => !model.allowed);
		expect(denied.length).toBeGreaterThan(0);
		for (const model of denied) {
			expect(model.deniedBy).not.toBeNull();
			expect(model.deniedBy?.verdict).toBe("deny");
			expect(model.deniedBy?.reason.length).toBeGreaterThan(0);
			expect(model.deniedBy?.detail.length).toBeGreaterThan(0);
			expect(model.deniedBy?.input.source.length).toBeGreaterThan(0);
			expect(model.deniedBy?.input.observed).toBe(model.tier);
			expect(model.deniedBy?.input.expected).toEqual(["frontier"]);
		}
		for (const model of models.filter((entry) => entry.allowed)) {
			expect(model.deniedBy).toBeNull();
		}
	});

	it("`deniedBy` is the FIRST denying check when several deny", () => {
		const model = evaluateModelCatalogEntry(
			WORKERS_ECONOMY,
			input({
				wiredProviders: new Set(["azure-openai"]),
				orgAllowedTiers: ["frontier"],
			}),
		);
		expect(model.deniedBy?.filter).toBe("provider_wired");
		// The later denial is still recorded — the chain is complete, not short-circuited.
		expect(check(model.checks, "org_model_tier")?.verdict).toBe("deny");
	});
});

describe("model-catalog projection — provider wiring", () => {
	it("denies an unwired provider and names the wired set as the actionable input", () => {
		const model = evaluateModelCatalogEntry(
			WORKERS_ECONOMY,
			input({ wiredProviders: new Set(["azure-openai"]) }),
		);
		const wired = check(model.checks, "provider_wired");
		expect(wired?.verdict).toBe("deny");
		expect(wired?.reason).toBe("provider_not_wired");
		expect(wired?.input.expected).toEqual(["azure-openai"]);
		expect(wired?.input.observed).toBe("workers-ai");
	});

	it("denies every model when nothing is wired, with an explanation on each", () => {
		const models = evaluateModelCatalog(
			COGNITION_MODEL_CATALOG,
			input({ wiredProviders: new Set() }),
		);
		expect(models.every((model) => !model.allowed)).toBe(true);
		expect(
			models.every((model) => model.deniedBy?.reason === "provider_not_wired"),
		).toBe(true);
		expect(
			models.every((model) => model.deniedBy?.input.configured === false),
		).toBe(true);
	});
});

describe("model-catalog projection — provider health is unknown, never allow", () => {
	it("reports `unknown` with `configured: false` on every entry", () => {
		for (const model of evaluateModelCatalog(
			COGNITION_MODEL_CATALOG,
			input(),
		)) {
			const health = check(model.checks, "provider_health");
			expect(health?.verdict).toBe("unknown");
			expect(health?.reason).toBe("provider_health_not_observed");
			expect(health?.input.configured).toBe(false);
		}
	});

	it("an unknown health verdict does not deny", () => {
		const model = evaluateModelCatalogEntry(AZURE_FRONTIER, input());
		expect(model.allowed).toBe(true);
	});
});

describe("model-catalog projection — entitlement", () => {
	it("denies EVERY model with the admission code when no entitlement is configured", () => {
		const models = evaluateModelCatalog(
			COGNITION_MODEL_CATALOG,
			input({
				entitlement: {
					configured: false,
					active: false,
					status: null,
					code: "entitlement_not_configured",
				},
			}),
		);
		expect(models).toHaveLength(COGNITION_MODEL_CATALOG.length);
		expect(
			models.every(
				(model) => model.deniedBy?.reason === "entitlement_not_configured",
			),
		).toBe(true);
	});

	it("carries the admission path's period code, distinct from a bad status", () => {
		const lapsed = evaluateModelCatalogEntry(
			AZURE_FRONTIER,
			input({
				entitlement: {
					configured: true,
					active: false,
					status: "active",
					code: "entitlement_period_inactive",
				},
			}),
		);
		expect(lapsed.deniedBy?.reason).toBe("entitlement_period_inactive");
		const suspended = evaluateModelCatalogEntry(
			AZURE_FRONTIER,
			input({
				entitlement: {
					configured: true,
					active: false,
					status: "suspended",
					code: "entitlement_inactive",
				},
			}),
		);
		expect(suspended.deniedBy?.reason).toBe("entitlement_inactive");
		expect(suspended.deniedBy?.input.observed).toBe("suspended");
	});
});

describe("model-catalog projection — tier policy", () => {
	it("an unset org tier policy is `not_configured`, never a silent allow", () => {
		const model = evaluateModelCatalogEntry(AZURE_FRONTIER, input());
		const org = check(model.checks, "org_model_tier");
		expect(org?.verdict).toBe("not_configured");
		expect(org?.verdict).not.toBe("allow");
		expect(org?.input.configured).toBe(false);
		expect(org?.input.expected).toBeNull();
		// It must SAY the input is unsettable rather than implying an operator
		// chose "unrestricted".
		expect(org?.detail).toContain(ORG_TIER_UNSETTABLE_NOTE);
	});

	it("distinguishes which scope denied — org vs tedi", () => {
		const orgDenied = evaluateModelCatalogEntry(
			WORKERS_ECONOMY,
			input({
				orgAllowedTiers: ["frontier"],
				tedi: {
					allowedTiers: null,
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				},
			}),
		);
		expect(orgDenied.deniedBy?.filter).toBe("org_model_tier");
		expect(orgDenied.deniedBy?.input.source).toBe(
			"billing_inference_policies.organization.allowed_model_tiers",
		);

		const tediDenied = evaluateModelCatalogEntry(
			WORKERS_ECONOMY,
			input({
				orgAllowedTiers: null,
				tedi: {
					allowedTiers: ["frontier"],
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				},
			}),
		);
		expect(tediDenied.deniedBy?.filter).toBe("tedi_model_tier");
		expect(tediDenied.deniedBy?.input.source).toBe(
			"billing_inference_policies.tedi.allowed_model_tiers",
		);
		expect(tediDenied.deniedBy?.reason).toBe("model_tier_not_allowed");
	});

	it("an unset TEDI tier policy carries no unsettable note — it is settable via tedis.update", () => {
		const model = evaluateModelCatalogEntry(
			AZURE_FRONTIER,
			input({
				tedi: {
					allowedTiers: null,
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				},
			}),
		);
		expect(check(model.checks, "tedi_model_tier")?.detail).not.toContain(
			ORG_TIER_UNSETTABLE_NOTE,
		);
	});
});

describe("model-catalog projection — runtime compatibility", () => {
	it("admits a Workers AI ref now that the Agent runtime owns that adapter", () => {
		const model = evaluateModelCatalogEntry(
			WORKERS_ECONOMY,
			input({
				tedi: {
					allowedTiers: null,
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				},
			}),
		);
		const compat = check(model.checks, "runtime_compatibility");
		expect(compat?.verdict).toBe("allow");
		expect(compat?.input.expected).toEqual([
			"azure-openai",
			"cloudflare",
			"workers-ai",
		]);
	});

	it("admits an Azure ref on the same runtime", () => {
		const model = evaluateModelCatalogEntry(
			AZURE_FRONTIER,
			input({
				tedi: {
					allowedTiers: null,
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				},
			}),
		);
		expect(check(model.checks, "runtime_compatibility")?.verdict).toBe("allow");
		expect(model.allowed).toBe(true);
	});
});

describe("model-catalog projection — caller authority", () => {
	it("reports `not_configured` when no caller-scoped authority is wired", () => {
		const model = evaluateModelCatalogEntry(AZURE_FRONTIER, input());
		const authority = check(model.checks, "caller_authority");
		expect(authority?.verdict).toBe("not_configured");
		expect(authority?.input.configured).toBe(false);
		expect(model.allowed).toBe(true);
	});

	it("denies a ref outside an explicit authority grant", () => {
		const model = evaluateModelCatalogEntry(
			WORKERS_ECONOMY,
			input({ callerAuthorityModelRefs: [AZURE_FRONTIER.ref] }),
		);
		expect(model.deniedBy?.filter).toBe("caller_authority");
		expect(model.deniedBy?.input.expected).toEqual([AZURE_FRONTIER.ref]);
	});
});

describe("model-catalog projection — no secret can cross the boundary", () => {
	it("projects provider wiring as ids only; no check input carries a value beyond ids/tiers/refs", () => {
		const models = evaluateModelCatalog(
			COGNITION_MODEL_CATALOG,
			input({
				tedi: {
					allowedTiers: ["balanced"],
					runtimeProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
				},
			}),
		);
		const knownValues = new Set<string>([
			...COGNITION_MODEL_CATALOG.map((entry) => entry.ref),
			...COGNITION_MODEL_CATALOG.map((entry) => entry.provider),
			...COGNITION_MODEL_CATALOG.map((entry) => entry.tier),
			"trial",
			"active",
			"suspended",
		]);
		for (const model of models) {
			for (const entry of model.checks) {
				for (const value of [
					...(entry.input.expected ?? []),
					...(entry.input.observed === null ? [] : [entry.input.observed]),
				]) {
					expect(knownValues.has(value)).toBe(true);
				}
			}
		}
	});
});

describe("model-catalog projection — declared image-input capability", () => {
	it("carries each entry's declared value through to the projection", () => {
		const models = evaluateModelCatalog(COGNITION_MODEL_CATALOG, input());
		for (const [index, model] of models.entries()) {
			expect(model.imageInput).toBe(COGNITION_MODEL_CATALOG[index]?.imageInput);
		}
		const azure = models.find((model) => model.ref === AZURE_FRONTIER.ref);
		expect(azure?.imageInput).toBe("supported");
		const workers = models.find((model) => model.ref === WORKERS_ECONOMY.ref);
		expect(workers?.imageInput).toBe("unsupported");
	});

	it("is a capability, not a filter: it never denies and survives a denial", () => {
		const denied = evaluateModelCatalogEntry(
			AZURE_FRONTIER,
			input({ orgAllowedTiers: ["economy"] }),
		);
		expect(denied.allowed).toBe(false);
		expect(denied.imageInput).toBe("supported");
		expect(denied.checks.some((entry) => entry.reason.includes("image"))).toBe(
			false,
		);
	});

	it("keeps `unknown` reachable on the wire for a model outside the catalog", () => {
		const custom: ModelCatalogEntry = {
			ref: "azure-openai/org-custom-deployment",
			provider: "azure-openai",
			modelId: "org-custom-deployment",
			label: "Org custom deployment",
			reasoning: false,
			tier: "balanced",
			imageInput: "unknown",
			governance: {
				weightAccess: "closed-weights",
				residencyControl: "customer-provider",
				routingMode: "fixed",
			},
			lifecycle: "active",
		};
		const model = evaluateModelCatalogEntry(custom, input());
		expect(ModelCatalogModelSchema.parse(model).imageInput).toBe("unknown");
	});
});
