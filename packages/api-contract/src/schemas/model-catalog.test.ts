import { modelCatalogEntry } from "../test/model-catalog";
import { describe, expect, it } from "vite-plus/test";
import {
	adaptiveRoutingEligible,
	buildModelRef,
	findCatalogEntry,
	isCatalogEntryResolvable,
	isModelRefAllowed,
	type ModelProviderId,
	parseModelRef,
	resolveModelImageInput,
	resolveModelSelection,
	sanitizeModelOverride,
} from "./model-catalog";

const TEST_CATALOG = [
	modelCatalogEntry("azure-openai/gpt-5.6-terra", { lifecycle: "superseded" }),
	modelCatalogEntry("azure-openai/gpt-5.6-sol"),
	modelCatalogEntry("azure-openai/gpt-5.6-luna"),
	modelCatalogEntry("workers-ai/@cf/openai/gpt-oss-120b"),
	modelCatalogEntry("cloudflare/auto", {
		label: "Auto",
		governance: {
			weightAccess: "mixed",
			residencyControl: "router-selected",
			routingMode: "adaptive",
		},
	}),
];
const AZURE_ONLY: ReadonlySet<ModelProviderId> = new Set(["azure-openai"]);

describe("model-catalog ref parsing", () => {
	it("parses a well-formed provider/model ref", () => {
		expect(parseModelRef("azure-openai/gpt-5.6-terra")).toEqual({
			provider: "azure-openai",
			modelId: "gpt-5.6-terra",
		});
	});

	it("keeps embedded slashes in the model-id segment", () => {
		expect(parseModelRef("azure-openai/group/deploy")).toEqual({
			provider: "azure-openai",
			modelId: "group/deploy",
		});
	});

	it("rejects malformed or unknown-provider refs", () => {
		expect(parseModelRef("")).toBeNull();
		expect(parseModelRef("gpt-5.6-terra")).toBeNull();
		expect(parseModelRef("/gpt-5.6-terra")).toBeNull();
		expect(parseModelRef("azure-openai/")).toBeNull();
		expect(parseModelRef("made-up-provider/x")).toBeNull();
	});

	it("builds the canonical ref", () => {
		expect(buildModelRef("azure-openai", "gpt-5.6-terra")).toBe(
			"azure-openai/gpt-5.6-terra",
		);
	});
});

describe("model-catalog allowlist gate", () => {
	it("allows a catalog ref whose provider is available with no explicit allowlist", () => {
		expect(
			isModelRefAllowed("azure-openai/gpt-5.6-sol", {
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toBe(true);
	});

	it("rejects a ref whose provider is not wired in this environment", () => {
		expect(
			isModelRefAllowed("anthropic/claude-opus", {
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toBe(false);
	});

	it("rejects a ref absent from the catalog (typo'd deployment)", () => {
		expect(
			isModelRefAllowed("azure-openai/gpt-9-imaginary", {
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toBe(false);
	});

	it("honors an explicit allowlist subset", () => {
		const opts = {
			catalog: TEST_CATALOG,
			availableProviders: AZURE_ONLY,
			allowlist: ["azure-openai/gpt-5.6-luna"],
		} as const;
		expect(isModelRefAllowed("azure-openai/gpt-5.6-luna", opts)).toBe(true);
		expect(isModelRefAllowed("azure-openai/gpt-5.6-sol", opts)).toBe(false);
	});
});

describe("model-catalog override sanitization (runtime drop-the-override shape)", () => {
	it("returns the override when it passes the gate", () => {
		expect(
			sanitizeModelOverride(
				{ modelRef: "azure-openai/gpt-5.6-terra" },
				{ catalog: TEST_CATALOG, availableProviders: AZURE_ONLY },
			),
		).toEqual({ modelRef: "azure-openai/gpt-5.6-terra" });
	});

	it("drops a disallowed / unserviceable / malformed override to null", () => {
		expect(
			sanitizeModelOverride(
				{ modelRef: "anthropic/claude-opus" },
				{ catalog: TEST_CATALOG, availableProviders: AZURE_ONLY },
			),
		).toBeNull();
		expect(
			sanitizeModelOverride(null, {
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toBeNull();
		expect(
			sanitizeModelOverride(
				{ modelRef: "not-a-ref" },
				{ catalog: TEST_CATALOG, availableProviders: AZURE_ONLY },
			),
		).toBeNull();
	});
});

describe("model-catalog selection (default-preserving)", () => {
	it("returns the env default unchanged when there is no override", () => {
		expect(
			resolveModelSelection({
				defaultRef: "azure-openai/gpt-5-1-preview",
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toEqual({
			provider: "azure-openai",
			modelId: "gpt-5-1-preview",
			ref: "azure-openai/gpt-5-1-preview",
			source: "default",
		});
	});

	it("does NOT allowlist-gate the env default (a non-catalog deployment still resolves)", () => {
		// The env default is trusted config, not a catalog menu item.
		const selection = resolveModelSelection({
			defaultRef: "azure-openai/some-private-deployment",
			catalog: TEST_CATALOG,
			availableProviders: AZURE_ONLY,
		});
		expect(selection?.source).toBe("default");
		expect(selection?.modelId).toBe("some-private-deployment");
	});

	it("applies a valid override", () => {
		expect(
			resolveModelSelection({
				defaultRef: "azure-openai/gpt-5-1-preview",
				override: { modelRef: "azure-openai/gpt-5.6-sol" },
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toEqual({
			provider: "azure-openai",
			modelId: "gpt-5.6-sol",
			ref: "azure-openai/gpt-5.6-sol",
			source: "override",
		});
	});

	it("falls back to the default when the override is disallowed", () => {
		const selection = resolveModelSelection({
			defaultRef: "azure-openai/gpt-5-1-preview",
			override: { modelRef: "anthropic/claude-opus" },
			catalog: TEST_CATALOG,
			availableProviders: AZURE_ONLY,
		});
		expect(selection?.source).toBe("default");
		expect(selection?.modelId).toBe("gpt-5-1-preview");
	});

	it("returns null only when the default ref is itself malformed", () => {
		expect(
			resolveModelSelection({
				defaultRef: "no-provider-deployment",
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toBeNull();
	});
});

describe("catalog shape", () => {
	it("uses concise display names without changing model identities", () => {
		expect(findCatalogEntry("cloudflare/auto", TEST_CATALOG)?.label).toBe(
			"Auto",
		);
		for (const entry of TEST_CATALOG) {
			expect(entry.label).not.toMatch(
				/\(|\)|Router|CTO-class|Workers AI|Azure/,
			);
			expect(entry.ref).toBe(buildModelRef(entry.provider, entry.modelId));
		}
	});

	it("every entry has a self-consistent canonical ref", () => {
		for (const entry of TEST_CATALOG) {
			expect(entry.ref).toBe(buildModelRef(entry.provider, entry.modelId));
			expect(findCatalogEntry(entry.ref, TEST_CATALOG)).toBe(entry);
			expect(["active", "superseded"]).toContain(entry.lifecycle);
			expect(entry.governance.routingMode).toMatch(/^(fixed|adaptive)$/);
		}
	});

	it("keeps a superseded entry resolvable for stored references", () => {
		const entry = {
			...TEST_CATALOG[0]!,
			lifecycle: "superseded" as const,
		};
		expect(
			isCatalogEntryResolvable(entry, {
				catalog: TEST_CATALOG,
				availableProviders: AZURE_ONLY,
			}),
		).toBe(true);
	});
});

describe("adaptive routing policy", () => {
	const eligible = {
		surface: "cron",
		authority: "ordinary",
		reproducibility: "adaptive",
		sovereignty: "unconstrained",
	} as const;

	it("admits ordinary chat and background inference", () => {
		expect(adaptiveRoutingEligible(eligible)).toBe(true);
		expect(adaptiveRoutingEligible({ ...eligible, surface: "chat" })).toBe(
			true,
		);
		expect(adaptiveRoutingEligible({ ...eligible, surface: "observer" })).toBe(
			true,
		);
	});

	it.each([
		{ reproducibility: "fixed-model-required" as const },
		{ sovereignty: "residency-bound" as const },
	])("fails closed for $key", (change) => {
		expect(adaptiveRoutingEligible({ ...eligible, ...change })).toBe(false);
	});

	it("admits all authorized surfaces unless explicit constraints forbid adaptation", () => {
		expect(adaptiveRoutingEligible(null)).toBe(true);
		expect(
			adaptiveRoutingEligible({
				...eligible,
				surface: "judgment",
				authority: "authority-sensitive",
			}),
		).toBe(true);
		expect(
			adaptiveRoutingEligible({ ...eligible, surface: "evaluation" }),
		).toBe(true);
	});

	it("catalogues cloudflare/auto with honest mixed governance metadata", () => {
		expect(
			findCatalogEntry("cloudflare/auto", TEST_CATALOG)?.governance,
		).toEqual({
			weightAccess: "mixed",
			residencyControl: "router-selected",
			routingMode: "adaptive",
		});
	});
});

describe("model-catalog image-input capability (tri-state)", () => {
	it("resolves a catalogued model's DECLARED value", () => {
		// Azure gpt-5.6-* matches the runtime's own VISION_CHAT_DEPLOYMENT_PREFIXES.
		expect(
			resolveModelImageInput("azure-openai/gpt-5.6-sol", TEST_CATALOG),
		).toBe("supported");
		// Workers AI turns flatten non-text parts to `[file]` before the call.
		expect(
			resolveModelImageInput(
				"workers-ai/@cf/openai/gpt-oss-120b",
				TEST_CATALOG,
			),
		).toBe("unsupported");
	});

	it("resolves `unknown` for a ref the catalog does not describe", () => {
		// A custom/org-configured deployment, a typo, and the (ungated) env
		// default all land here. None of them may default to `supported`.
		expect(
			resolveModelImageInput(
				"azure-openai/some-private-deployment",
				TEST_CATALOG,
			),
		).toBe("unknown");
		expect(
			resolveModelImageInput("azure-openai/gpt-9-imaginary", TEST_CATALOG),
		).toBe("unknown");
		expect(resolveModelImageInput("anthropic/claude-opus", TEST_CATALOG)).toBe(
			"unknown",
		);
		expect(resolveModelImageInput("not-a-ref", TEST_CATALOG)).toBe("unknown");
		expect(resolveModelImageInput("", TEST_CATALOG)).toBe("unknown");
	});

	it("declares a capability on EVERY catalog entry, per provider serving path", () => {
		for (const entry of TEST_CATALOG) {
			expect(resolveModelImageInput(entry.ref, TEST_CATALOG)).toBe(
				entry.imageInput,
			);
			if (entry.provider === "workers-ai") {
				// No `@cf/...` model can be handed an image on this adapter.
				expect(entry.imageInput).toBe("unsupported");
			}
		}
	});
});
