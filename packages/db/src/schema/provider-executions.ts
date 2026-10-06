import type {
	ProviderExecutionOrigin,
	ProviderExecutionPolicy,
} from "@tedix/api-contract/schemas/provider-execution";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Immutable tenant admission evidence; identifiers survive referenced lifecycle changes. */
export const providerExecutionAttempts = sqliteTable(
	"provider_execution_attempts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		tediId: text("tedi_id"),
		source: text("source").notNull(),
		runId: text("run_id"),
		workItemId: text("work_item_id"),
		traceId: text("trace_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		settlementMode: text("settlement_mode", {
			enum: ["managed", "external", "disabled"],
		}).notNull(),
		billingReservationId: text("billing_reservation_id"),
		provider: text("provider", {
			enum: ["azure-openai", "workers-ai", "typesafe"],
		}).notNull(),
		requestModel: text("request_model").notNull(),
		gatewayAccountId: text("gateway_account_id"),
		gatewayId: text("gateway_id"),
		transportKind: text("transport_kind", {
			enum: [
				"gateway-https",
				"gateway-binding",
				"workers-ai-binding",
				"cloudflare-ai-https",
				"direct-https",
			],
		}).notNull(),
		apiKind: text("api_kind", {
			enum: [
				"azure-chat",
				"azure-responses",
				"workers-ai-chat",
				"typesafe-systemone",
			],
		}).notNull(),
		providerResource: text("provider_resource"),
		providerOrigin: text("provider_origin"),
		deployment: text("deployment"),
		deploymentScope: text("deployment_scope").notNull(),
		authorizedAt: text("authorized_at").notNull(),
		sendBefore: text("send_before").notNull(),
		origin: text("origin", { mode: "json" }).$type<ProviderExecutionOrigin>(),
		originHash: text("origin_hash"),
		policy: text("policy", { mode: "json" }).$type<ProviderExecutionPolicy>(),
		policyHash: text("policy_hash"),
	},
	(table) => [
		uniqueIndex("uniq_provider_execution_admission").on(
			table.organizationId,
			table.idempotencyKey,
		),
		index("idx_provider_execution_run").on(table.organizationId, table.runId),
		check(
			"chk_provider_execution_window",
			sql`julianday(${table.authorizedAt}) IS NOT NULL AND julianday(${table.sendBefore}) IS NOT NULL AND julianday(${table.sendBefore}) > julianday(${table.authorizedAt})`,
		),
		check(
			"chk_provider_execution_reservation",
			sql`(${table.settlementMode} = 'managed' AND ${table.billingReservationId} IS NOT NULL) OR (${table.settlementMode} IN ('external','disabled') AND ${table.billingReservationId} IS NULL)`,
		),
		check(
			"chk_provider_execution_provider",
			sql`(${table.provider} = 'azure-openai' AND ${table.providerResource} IS NOT NULL AND ${table.providerOrigin} IS NOT NULL AND ${table.deployment} IS NOT NULL AND ${table.deployment} = ${table.requestModel} AND ${table.apiKind} IN ('azure-chat','azure-responses') AND ${table.transportKind} IN ('gateway-https','gateway-binding')) OR (${table.provider} = 'workers-ai' AND ${table.providerResource} IS NULL AND ${table.providerOrigin} IS NULL AND ${table.deployment} IS NULL AND ${table.apiKind} = 'workers-ai-chat' AND ${table.transportKind} IN ('gateway-https','gateway-binding','workers-ai-binding')) OR (${table.provider} = 'typesafe' AND ${table.providerResource} IS NULL AND ${table.deployment} IS NULL AND ${table.apiKind} = 'typesafe-systemone' AND ((${table.requestModel} = 'typesafe/jev' AND ${table.transportKind} = 'cloudflare-ai-https' AND ${table.providerOrigin} IS NULL) OR (${table.requestModel} = 'jev-1.13.0' AND ${table.transportKind} = 'direct-https' AND ${table.providerOrigin} IS NOT NULL AND ${table.providerOrigin} = 'https://api.typesafe.ai' AND ${table.gatewayAccountId} IS NULL AND ${table.gatewayId} IS NULL)))`,
		),
		check(
			"chk_provider_execution_identity",
			sql`(${table.transportKind} = 'direct-https' OR (${table.gatewayAccountId} IS NOT NULL AND ${table.gatewayId} IS NOT NULL AND length(trim(${table.gatewayAccountId})) > 0 AND length(trim(${table.gatewayId})) > 0)) AND length(trim(${table.requestModel})) > 0 AND length(trim(${table.deploymentScope})) > 0 AND length(trim(${table.organizationId})) > 0`,
		),
	],
);
export type ProviderExecutionAttemptRow =
	typeof providerExecutionAttempts.$inferSelect;
export type NewProviderExecutionAttemptRow =
	typeof providerExecutionAttempts.$inferInsert;
