/**
 * Runtime-entitlement operator read: the projection must mirror what the
 * admission path enforces — same query, same activity computation, same
 * resolved model policy — against a real D1 facade.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	billingAccounts,
	billingInferencePolicies,
	billingPlanVersions,
	organizations,
	tedis,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { runtimeEntitlementsContractRouter } from "./runtime-entitlements";

let sqlite: DatabaseSync;

function context(
	organizationId: string | null,
	permissions: string[] = ["settings:manage"],
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(createD1Facade(sqlite)) as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		} as CloudflareEnv,
		headers: new Headers(),
		organizationId: organizationId ?? undefined,
		url: new URL("https://api/rpc/runtimeEntitlements/get"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function client(organizationId: string | null, permissions?: string[]) {
	return createRouterClient(runtimeEntitlementsContractRouter, {
		context: context(organizationId, permissions),
	});
}

function seedOrganization(id: string, metadata: unknown = null) {
	sqlite
		.prepare(
			`INSERT INTO organizations (id, name, slug, metadata) VALUES (?, ?, ?, ?)`,
		)
		.run(id, id, id, metadata === null ? null : JSON.stringify(metadata));
}

function seedPlan(id: string, name: string) {
	sqlite
		.prepare(
			`INSERT INTO billing_plan_versions (
				id, plan_key, version, status, name, included_monthly_tokens,
				max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
				default_daily_token_limit, default_daily_message_limit, effective_at,
				created_at
			) VALUES (?, 'growth', 1, 'active', ?, 1000000, 5, 3, 25, 100000, 200,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(id, name);
}

function seedAccount(input: {
	organizationId: string;
	planVersionId: string;
	status: string;
	periodStart: string;
	periodEnd: string;
}) {
	sqlite
		.prepare(
			`INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode, period_start,
				period_end, created_at, updated_at
			) VALUES (?, ?, ?, 'stripe', ?, ?,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(
			input.organizationId,
			input.planVersionId,
			input.status,
			input.periodStart,
			input.periodEnd,
		);
}

function seedOrganizationPolicy(input: {
	organizationId: string;
	allowedModelTiers: string[];
	dailyTokenLimit?: number;
}) {
	sqlite
		.prepare(
			`INSERT INTO billing_inference_policies (
				id, organization_id, scope, subject_key, allowed_model_tiers,
				daily_token_limit, created_at, updated_at
			) VALUES (?, ?, 'organization', 'organization', ?, ?,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(
			`policy:${input.organizationId}`,
			input.organizationId,
			JSON.stringify(input.allowedModelTiers),
			input.dailyTokenLimit ?? null,
		);
}

const FUTURE = "2100-01-01T00:00:00.000Z";
const PAST_START = "2026-01-01T00:00:00.000Z";
const PAST_END = "2026-02-01T00:00:00.000Z";

describe("runtimeEntitlements.get", () => {
	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(
			schemaDdl(
				organizations,
				tedis,
				billingAccounts,
				billingPlanVersions,
				billingInferencePolicies,
			),
		);
	});

	it("returns null entitlement and policy when nothing is configured", async () => {
		seedOrganization("org-1");
		await expect(client("org-1").get({})).resolves.toEqual({
			entitlement: null,
			modelPolicy: null,
		});
	});

	it("projects the active entitlement with the admission path's resolved policy", async () => {
		seedOrganization("org-1");
		seedPlan("plan-1", "Growth");
		seedAccount({
			organizationId: "org-1",
			planVersionId: "plan-1",
			status: "active",
			periodStart: PAST_START,
			periodEnd: FUTURE,
		});
		seedOrganizationPolicy({
			organizationId: "org-1",
			allowedModelTiers: ["balanced", "frontier"],
			dailyTokenLimit: 50000,
		});
		await expect(client("org-1").get({})).resolves.toEqual({
			entitlement: {
				planKey: "growth",
				planName: "Growth",
				status: "active",
				periodStart: PAST_START,
				periodEnd: FUTURE,
				active: true,
				settlementMode: "managed",
				source: "managed-plan",
				version: 1,
			},
			modelPolicy: {
				allowedModelTiers: ["balanced", "frontier"],
				dailyTokenLimit: 50000,
			},
		});
	});

	it("computes active=false for a suspended entitlement — the state that blocks kernel chat", async () => {
		seedOrganization("org-1");
		seedPlan("plan-1", "Growth");
		seedAccount({
			organizationId: "org-1",
			planVersionId: "plan-1",
			status: "suspended",
			periodStart: PAST_START,
			periodEnd: FUTURE,
		});
		const result = await client("org-1").get({});
		expect(result.entitlement).toMatchObject({
			status: "suspended",
			active: false,
		});
	});

	it("computes active=false when the effective period has lapsed, even on an active status", async () => {
		seedOrganization("org-1");
		seedPlan("plan-1", "Growth");
		seedAccount({
			organizationId: "org-1",
			planVersionId: "plan-1",
			status: "active",
			periodStart: PAST_START,
			periodEnd: PAST_END,
		});
		const result = await client("org-1").get({});
		expect(result.entitlement).toMatchObject({
			status: "active",
			active: false,
		});
	});

	it("scopes the read to the caller's organization", async () => {
		seedOrganization("org-1");
		seedOrganization("org-2");
		seedPlan("plan-1", "Growth");
		seedAccount({
			organizationId: "org-1",
			planVersionId: "plan-1",
			status: "active",
			periodStart: PAST_START,
			periodEnd: FUTURE,
		});
		seedOrganizationPolicy({
			organizationId: "org-1",
			allowedModelTiers: ["frontier"],
		});
		await expect(client("org-2").get({})).resolves.toEqual({
			entitlement: null,
			modelPolicy: null,
		});
	});

	it("admits a user with only the os:read verb", async () => {
		seedOrganization("org-1");
		await expect(client("org-1", ["os:read"]).get({})).resolves.toEqual({
			entitlement: null,
			modelPolicy: null,
		});
	});

	it("rejects a user with neither os:read nor settings:manage", async () => {
		seedOrganization("org-1");
		await expect(client("org-1", []).get({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			client("org-1", ["os:author", "os:run"]).get({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects a caller with no organization scope", async () => {
		await expect(client(null).get({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
it("service transport cannot spoof direct-kernel admission with source or null attribution", async () => {
	const ctx = context("org-1");
	ctx.headers.set("X-Service-Binding", "true");
	ctx.env = {
		...ctx.env,
		TEDIX_BILLING_SETTLEMENT_MODE: "external",
		SECRETS_MASTER_KEY: "secret",
	};
	const rpc = createRouterClient(runtimeEntitlementsContractRouter, {
		context: ctx,
	});
	await expect(
		rpc.authorizeInference({
			organizationId: "org-1",
			tediId: null,
			settlementMode: "external",
			source: "kernel",
			execution: {
				provider: "workers-ai",
				requestModel: "@cf/test",
				gatewayAccountId: "account",
				gatewayId: "gateway",
				transportKind: "workers-ai-binding",
				apiKind: "workers-ai-chat",
				providerResource: null,
				providerOrigin: null,
				deployment: null,
			},
			workItemId: null,
			estimatedInputTokens: 1,
			estimatedOutputTokens: 1,
			runId: null,
			idempotencyKey: "remote-kernel",
			originToken: "invalid",
		}),
	).rejects.toThrow(/signature/);
});
