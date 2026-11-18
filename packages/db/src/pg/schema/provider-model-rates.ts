import { sql } from "drizzle-orm";
import {
	check,
	index,
	bigint,
	pgTable,
	text,
	uniqueIndex,
	type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** Append-only provider evidence versions; customer tariffs remain in billing tables. */
export const providerModelRateVersions = pgTable(
	"provider_model_rate_versions",
	{
		id: text("id").primaryKey(),
		provider: text("provider").notNull(),
		modelId: text("model_id").notNull(),
		deploymentScope: text("deployment_scope").notNull(),
		/** Inclusive prompt input-token count; cached tokens are included. */
		inputTokenMin: bigint("input_token_min", { mode: "number" })
			.notNull()
			.default(0),
		/** Exclusive upper bound, or null for an unbounded context class. */
		inputTokenMax: bigint("input_token_max", { mode: "number" }),
		effectiveFrom: text("effective_from").notNull(),
		inputMicrousdPerMillion: bigint("input_microusd_per_million", {
			mode: "number",
		}).notNull(),
		outputMicrousdPerMillion: bigint("output_microusd_per_million", {
			mode: "number",
		}).notNull(),
		cacheReadMicrousdPerMillion: bigint("cache_read_microusd_per_million", {
			mode: "number",
		}).notNull(),
		cacheWriteMicrousdPerMillion: bigint("cache_write_microusd_per_million", {
			mode: "number",
		}).notNull(),
		currency: text("currency", { enum: ["USD"] }).notNull(),
		evidenceUri: text("evidence_uri").notNull(),
		evidenceDigest: text("evidence_digest").notNull(),
		verifiedAt: text("verified_at").notNull(),
		publishedAt: text("published_at").notNull(),
		publishedBy: text("published_by").notNull(),
		changeReason: text("change_reason").notNull(),
		supersedesRateVersionId: text("supersedes_rate_version_id").references(
			(): AnyPgColumn => providerModelRateVersions.id,
			{ onDelete: "restrict" },
		),
	},
	(table) => [
		index("idx_provider_model_rate_lookup").on(
			table.provider,
			table.modelId,
			table.deploymentScope,
			table.effectiveFrom,
		),
		uniqueIndex("uniq_provider_model_rate_correction").on(
			table.supersedesRateVersionId,
		),
		check(
			"chk_provider_model_rate_scope",
			sql`length(trim(${table.deploymentScope}, E'\\t\\n\\r ')) > 0`,
		),
		check(
			"chk_provider_model_rate_interval",
			sql`(${table.effectiveFrom}::timestamptz) IS NOT NULL`,
		),
		check("chk_provider_model_rate_currency", sql`${table.currency} = 'USD'`),
		check(
			"chk_provider_model_rate_amounts",
			sql`${table.inputMicrousdPerMillion} BETWEEN 0 AND 9007199254740991 AND ${table.outputMicrousdPerMillion} BETWEEN 0 AND 9007199254740991 AND ${table.cacheReadMicrousdPerMillion} BETWEEN 0 AND 9007199254740991 AND ${table.cacheWriteMicrousdPerMillion} BETWEEN 0 AND 9007199254740991`,
		),
	],
);
export type ProviderModelRateVersionRow =
	typeof providerModelRateVersions.$inferSelect;
export type NewProviderModelRateVersionRow =
	typeof providerModelRateVersions.$inferInsert;
