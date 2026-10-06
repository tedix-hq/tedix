/**
 * The model catalog is a PROJECTION: these assert it against a real D1 facade
 * and, where a claim is about the enforcer, against the enforcer itself
 * (`aiGatewayModelTierAllowed`) rather than a restatement of the projection.
 *
 * Fixture discipline: every seeded column is written with the SAME shape its
 * producer writes — `organizations.metadata` and `tedis.budgets` are JSON text
 * columns the API writes as JSON, `tedis.runtime_overrides` is the raw object
 * the dashboard's ModelSection writes, and `runtime_profiles.config` is the
 * `RuntimeProfileConfig` shape `updateRuntimeProfile` stores. No field is
 * invented that the producing path does not emit.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	COGNITION_MODEL_CATALOG,
	findCatalogEntry,
} from "@tedix/api-contract/schemas/model-catalog";
import { createDbClient } from "@tedix/db/client";
import {
	billingAccounts,
	billingInferencePolicies,
	billingPlanVersions,
	organizations,
	runtimeProfiles,
	tedis,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
	aiGatewayModelTierAllowed,
	resolveAiGatewayAdmissionPolicy,
} from "../../services/ai-gateway-admission-policy";
import { wiredProviders } from "../../services/model-catalog-projection";
import type { BaseContext } from "../orpc";
import { modelCatalogContractRouter } from "./model-catalog";

let sqlite: DatabaseSync;

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TEDI = "33333333-3333-4333-8333-333333333333";
const OTHER_TEDI = "44444444-4444-4444-8444-444444444444";
const PROFILE = "55555555-5555-4555-8555-555555555555";
const FUTURE = "2100-01-01T00:00:00.000Z";
const PAST_START = "2026-01-01T00:00:00.000Z";
const PAST_END = "2026-02-01T00:00:00.000Z";

/** Both providers wired: gateway BYOK + Azure endpoint + deployment, and the AI binding. */
const FULL_ENV = {
	ENVIRONMENT: "test",
	AI: {},
	AI_GATEWAY_ACCOUNT_ID: "acct",
	AI_GATEWAY_LLM_ID: "gw",
	CF_AI_GATEWAY_TOKEN: "token",
	AZURE_OPENAI_RESOURCE: "tedix-resource",
	AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
} as unknown as CloudflareEnv;

function context(
	organizationId: string | null,
	options: {
		permissions?: string[];
		env?: CloudflareEnv;
		roles?: string[];
	} = {},
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(createD1Facade(sqlite)) as BaseContext["db"],
		env: options.env ?? FULL_ENV,
		headers: new Headers(),
		organizationId: organizationId ?? undefined,
		url: new URL("https://api/rpc/modelCatalog/list"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: options.permissions ?? ["settings:manage"],
			roles: options.roles ?? [],
			sub: "user-1",
		},
	} as BaseContext;
}

function client(
	organizationId: string | null,
	options?: Parameters<typeof context>[1],
) {
	return createRouterClient(modelCatalogContractRouter, {
		context: context(organizationId, options),
	});
}

function seedOrganization(id: string, metadata: unknown = null) {
	sqlite
		.prepare(
			`INSERT INTO organizations (id, name, slug, metadata) VALUES (?, ?, ?, ?)`,
		)
		.run(id, id, id, metadata === null ? null : JSON.stringify(metadata));
}

function seedPlanAndAccount(organizationId: string, status = "active") {
	sqlite
		.prepare(
			`INSERT OR IGNORE INTO billing_plan_versions (
				id, plan_key, version, status, name, included_monthly_tokens,
				max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
				default_daily_token_limit, default_daily_message_limit, effective_at,
				created_at
			) VALUES ('plan-1', 'growth', 1, 'active', 'Growth', 1000000, 5, 3, 25,
				100000, 200, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run();
	sqlite
		.prepare(
			`INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode, period_start,
				period_end, created_at, updated_at
			) VALUES (?, 'plan-1', ?, 'stripe', ?, ?,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(organizationId, status, PAST_START, FUTURE);
}

function seedTedi(input: {
	id: string;
	organizationId: string;
	budgets?: unknown;
	runtimeOverrides?: unknown;
	runtimeProfileId?: string | null;
}) {
	sqlite
		.prepare(
			`INSERT INTO tedis (id, organization_id, name, slug, budgets, runtime_overrides, runtime_profile_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.organizationId,
			input.id,
			input.id,
			input.budgets === undefined ? null : JSON.stringify(input.budgets),
			input.runtimeOverrides === undefined
				? null
				: JSON.stringify(input.runtimeOverrides),
			input.runtimeProfileId ?? null,
		);
}

function seedInferencePolicy(input: {
	organizationId: string;
	tediId?: string;
	allowedModelTiers: string[];
}) {
	const subjectKey = input.tediId ?? "organization";
	sqlite
		.prepare(
			`INSERT INTO billing_inference_policies (
				id, organization_id, scope, subject_key, tedi_id, allowed_model_tiers,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(
			`policy:${input.organizationId}:${subjectKey}`,
			input.organizationId,
			input.tediId ? "tedi" : "organization",
			subjectKey,
			input.tediId ?? null,
			JSON.stringify(input.allowedModelTiers),
		);
}

function seedRuntimeProfile(input: {
	id: string;
	organizationId: string | null;
	scope?: string;
	config: unknown;
}) {
	sqlite
		.prepare(
			`INSERT INTO runtime_profiles (id, organization_id, name, slug, scope, status, version, config)
			 VALUES (?, ?, ?, ?, ?, 'active', 1, ?)`,
		)
		.run(
			input.id,
			input.organizationId,
			input.id,
			input.id,
			input.scope ?? "organization",
			JSON.stringify(input.config),
		);
}

/** The dashboard ModelSection writes exactly this shape. */
function modelOverride(primary: string) {
	return { agents: { defaults: { model: { primary } } } };
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			tedis,
			runtimeProfiles,
			billingAccounts,
			billingInferencePolicies,
			billingPlanVersions,
		),
	);
});

describe("modelCatalog.list — authz", () => {
	it("admits a user with only the os:read verb", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const result = await client(ORG, { permissions: ["os:read"] }).list({
			includeDenied: true,
		});
		expect(result.models).toHaveLength(COGNITION_MODEL_CATALOG.length);
		expect(
			result.models.every(
				(model) =>
					model.selectable === (model.lifecycle === "active" && model.allowed),
			),
		).toBe(true);
	});

	it("rejects a user with neither os:read nor settings:manage", async () => {
		seedOrganization(ORG);
		await expect(
			client(ORG, { permissions: ["os:author"] }).list({ includeDenied: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects a caller with no organization scope", async () => {
		await expect(
			client(null).list({ includeDenied: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses a tedi in another organization", async () => {
		seedOrganization(ORG);
		seedOrganization(OTHER_ORG);
		seedPlanAndAccount(ORG);
		seedTedi({ id: OTHER_TEDI, organizationId: OTHER_ORG });
		await expect(
			client(ORG).list({ tediId: OTHER_TEDI, includeDenied: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("404s an unknown tedi rather than projecting an org-only view", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		await expect(
			client(ORG).list({ tediId: OTHER_TEDI, includeDenied: true }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("modelCatalog.list — entitlement gate", () => {
	it("denies every model with the admission code when no entitlement exists", async () => {
		seedOrganization(ORG);
		const result = await client(ORG).list({ includeDenied: true });
		// The list is FULL and explained — never an empty list with no reason.
		expect(result.models).toHaveLength(COGNITION_MODEL_CATALOG.length);
		expect(result.models.every((model) => !model.allowed)).toBe(true);
		expect(
			result.models.every(
				(model) => model.deniedBy?.reason === "entitlement_not_configured",
			),
		).toBe(true);
	});

	it("carries the period code when the entitlement window has lapsed", async () => {
		seedOrganization(ORG);
		sqlite
			.prepare(
				`INSERT OR IGNORE INTO billing_plan_versions (
					id, plan_key, version, status, name, included_monthly_tokens,
					max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
					default_daily_token_limit, default_daily_message_limit, effective_at,
					created_at
				) VALUES ('plan-1', 'growth', 1, 'active', 'Growth', 1000000, 5, 3, 25,
					100000, 200, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO billing_accounts (
					organization_id, plan_version_id, status, billing_mode, period_start,
					period_end, created_at, updated_at
				) VALUES (?, 'plan-1', 'active', 'stripe', ?, ?,
					'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(ORG, PAST_START, PAST_END);
		const result = await client(ORG).list({ includeDenied: true });
		expect(
			result.models.every(
				(model) => model.deniedBy?.reason === "entitlement_period_inactive",
			),
		).toBe(true);
	});
});

describe("modelCatalog.list — tier policy matches the enforcer", () => {
	it("the org+tedi verdict equals aiGatewayModelTierAllowed for every catalog entry", async () => {
		const organization = { allowedModelTiers: ["balanced", "frontier"] };
		const tedi = { allowedModelTiers: ["balanced"] };
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedTedi({ id: TEDI, organizationId: ORG });
		seedInferencePolicy({
			organizationId: ORG,
			allowedModelTiers: organization.allowedModelTiers,
		});
		seedInferencePolicy({
			organizationId: ORG,
			tediId: TEDI,
			allowedModelTiers: tedi.allowedModelTiers,
		});

		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		const policy = resolveAiGatewayAdmissionPolicy({
			organization,
			tedi,
		});
		for (const model of result.models) {
			const entry = findCatalogEntry(model.ref);
			expect(entry).toBeDefined();
			const tierChecksPass = model.checks
				.filter(
					(check) =>
						check.filter === "org_model_tier" ||
						check.filter === "tedi_model_tier",
				)
				.every((check) => check.verdict !== "deny");
			expect(tierChecksPass).toBe(
				aiGatewayModelTierAllowed(model.provider, model.modelId, policy),
			);
		}
	});

	it("names the ORG scope when only the org policy denies", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedInferencePolicy({
			organizationId: ORG,
			allowedModelTiers: ["frontier"],
		});
		const result = await client(ORG).list({ includeDenied: true });
		const economy = result.models.filter((model) => model.tier === "economy");
		expect(economy.length).toBeGreaterThan(0);
		for (const model of economy) {
			expect(model.deniedBy?.filter).toBe("org_model_tier");
			expect(model.deniedBy?.input.source).toBe(
				"billing_inference_policies.organization.allowed_model_tiers",
			);
			expect(model.deniedBy?.input.expected).toEqual(["frontier"]);
			expect(model.deniedBy?.input.observed).toBe("economy");
		}
	});

	it("says the org tier input is UNSETTABLE when it is absent, rather than implying an operator allowed everything", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const result = await client(ORG).list({ includeDenied: true });
		const orgCheck = result.models[0]?.checks.find(
			(check) => check.filter === "org_model_tier",
		);
		expect(orgCheck?.verdict).toBe("not_configured");
		expect(orgCheck?.input.configured).toBe(false);
		expect(orgCheck?.detail).toContain("no write path");
	});
});

describe("modelCatalog.list — selection kinds are distinguished", () => {
	it("reports the adaptive platform default and unsupported user preference", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const result = await client(ORG).list({ includeDenied: true });
		expect(result.selections.map((selection) => selection.kind)).toEqual([
			"org_default",
			"user_conversational",
		]);
		const orgDefault = result.selections[0];
		expect(orgDefault).toMatchObject({
			kind: "org_default",
			scope: "deployment",
			status: "set",
			modelRef: "cloudflare/auto",
			selectable: true,
		});
		expect(orgDefault?.detail).toContain("platform default");
		expect(result.selections[1]).toMatchObject({
			kind: "user_conversational",
			status: "unsupported",
			modelRef: null,
			allowed: null,
			selectable: null,
		});
	});

	it("distinguishes tedi explicit from tedi inherited, and marks the inherited one overridden", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedRuntimeProfile({
			id: PROFILE,
			organizationId: ORG,
			config: { modelPolicy: { chatModelRef: "azure-openai/gpt-5.6-terra" } },
		});
		seedTedi({
			id: TEDI,
			organizationId: ORG,
			runtimeProfileId: PROFILE,
			runtimeOverrides: modelOverride("azure-openai/gpt-5.6-sol"),
		});
		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		const byKind = (kind: string, slot?: string) =>
			result.selections.find(
				(selection) =>
					selection.kind === kind && (slot ? selection.slot === slot : true),
			);
		expect(byKind("tedi_explicit")).toMatchObject({
			status: "set",
			modelRef: "azure-openai/gpt-5.6-sol",
			scope: "tedi",
		});
		expect(byKind("tedi_inherited")).toMatchObject({
			status: "set",
			modelRef: "azure-openai/gpt-5.6-terra",
		});
		expect(byKind("tedi_inherited")?.detail).toContain("OVERRIDDEN");
		expect(result.routing).toMatchObject({
			slot: "chat",
			modelRef: "azure-openai/gpt-5.6-sol",
			selectedBy: "tedi_explicit",
			allowed: true,
			selectable: false,
		});
	});

	it("routes via the runtime profile when no per-tedi pin is set", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedRuntimeProfile({
			id: PROFILE,
			organizationId: ORG,
			config: {
				modelPolicy: {
					chatModelRef: "azure-openai/gpt-5.6-terra",
					cronModelRef: "azure-openai/gpt-5.6-luna",
					observerModelRef: "azure-openai/gpt-5.6-luna",
				},
			},
		});
		seedTedi({ id: TEDI, organizationId: ORG, runtimeProfileId: PROFILE });
		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		expect(result.routing).toMatchObject({
			modelRef: "azure-openai/gpt-5.6-terra",
			selectedBy: "tedi_inherited",
		});
		const utility = result.selections.filter(
			(selection) => selection.kind === "utility",
		);
		expect(utility.map((selection) => selection.slot)).toEqual([
			"cron",
			"observer",
		]);
		expect(utility.every((selection) => selection.status === "set")).toBe(true);
	});

	it("falls back to the adaptive platform default when the tedi has no profile", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedTedi({ id: TEDI, organizationId: ORG });
		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		expect(result.routing).toMatchObject({
			modelRef: "cloudflare/auto",
			selectedBy: "org_default",
		});
	});

	it("surfaces a STORED but discarded pin instead of reporting it as simply unset", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		// The shape the dashboard's deleted MODEL_OPTIONS list actually wrote.
		seedTedi({
			id: TEDI,
			organizationId: ORG,
			runtimeOverrides: modelOverride("google/gemini-2.5-flash"),
		});
		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		const explicit = result.selections.find(
			(selection) => selection.kind === "tedi_explicit",
		);
		expect(explicit?.status).toBe("unset");
		expect(explicit?.modelRef).toBeNull();
		expect(explicit?.detail).toContain("google/gemini-2.5-flash");
		expect(explicit?.detail).toContain("discarded");
	});

	it("reports removed provider aliases as discarded stored pins", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedTedi({
			id: TEDI,
			organizationId: ORG,
			runtimeOverrides: modelOverride("azure-openai-responses/gpt-5.6-sol"),
		});
		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		const explicit = result.selections.find(
			(selection) => selection.kind === "tedi_explicit",
		);
		expect(explicit?.status).toBe("unset");
		expect(explicit?.detail).toContain("discarded");
	});

	it("refuses to project a runtime profile owned by another organization", async () => {
		seedOrganization(ORG);
		seedOrganization(OTHER_ORG);
		seedPlanAndAccount(ORG);
		seedRuntimeProfile({
			id: PROFILE,
			organizationId: OTHER_ORG,
			// A system SCOPE is not proof of ownerlessness — this row has an owner.
			scope: "system",
			config: { modelPolicy: { chatModelRef: "azure-openai/gpt-5.6-sol" } },
		});
		seedTedi({ id: TEDI, organizationId: ORG, runtimeProfileId: PROFILE });
		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		const inherited = result.selections.find(
			(selection) => selection.kind === "tedi_inherited",
		);
		expect(inherited?.modelRef).toBeNull();
		expect(inherited?.detail).toContain("different organization");
		// And the row's ref never leaks into the routing answer.
		expect(result.routing.modelRef).toBe("cloudflare/auto");
	});

	it("projects an ownerless (NULL organization_id) system profile", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedRuntimeProfile({
			id: PROFILE,
			organizationId: null,
			scope: "system",
			config: { modelPolicy: { chatModelRef: "azure-openai/gpt-5.6-sol" } },
		});
		seedTedi({ id: TEDI, organizationId: ORG, runtimeProfileId: PROFILE });
		const result = await client(ORG).list({
			tediId: TEDI,
			includeDenied: true,
		});
		expect(result.routing).toMatchObject({
			modelRef: "azure-openai/gpt-5.6-sol",
			selectedBy: "tedi_inherited",
		});
	});
});

describe("modelCatalog.list — provider wiring is presence-only", () => {
	it("derives the wired set from presence booleans and never echoes a credential", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const result = await client(ORG).list({ includeDenied: true });
		expect(result.wiredProviders).toEqual([
			"azure-openai",
			"cloudflare",
			"workers-ai",
		]);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("token");
		expect(serialized).not.toContain("acct");
	});

	it("drops azure from the wired set when gateway BYOK is incomplete", () => {
		expect([
			...wiredProviders({
				AI: {},
				AI_GATEWAY_ACCOUNT_ID: "acct",
				AI_GATEWAY_LLM_ID: "gw",
				AZURE_OPENAI_RESOURCE: "r",
				AZURE_CHAT_DEPLOYMENT: "d",
			}),
		]).toEqual(["workers-ai"]);
	});

	it("denies workers-ai models when the AI binding is absent", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const { AI: _AI, ...noAi } = FULL_ENV as unknown as Record<string, unknown>;
		const result = await client(ORG, {
			env: noAi as unknown as CloudflareEnv,
		}).list({ includeDenied: true });
		expect(result.wiredProviders).toEqual(["azure-openai", "cloudflare"]);
		const workersAi = result.models.filter(
			(model) => model.provider === "workers-ai",
		);
		expect(workersAi.length).toBeGreaterThan(0);
		expect(
			workersAi.every(
				(model) => model.deniedBy?.reason === "provider_not_wired",
			),
		).toBe(true);
	});
});

describe("modelCatalog.list — includeDenied", () => {
	it("returns only allowed models when includeDenied is false", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		seedInferencePolicy({
			organizationId: ORG,
			allowedModelTiers: ["frontier"],
		});
		const result = await client(ORG).list({ includeDenied: false });
		expect(result.models.length).toBeGreaterThan(0);
		expect(result.models.every((model) => model.allowed)).toBe(true);
		expect(result.models.length).toBeLessThan(COGNITION_MODEL_CATALOG.length);
	});
});
