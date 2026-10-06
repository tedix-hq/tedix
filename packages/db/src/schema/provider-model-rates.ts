import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
	type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/** Append-only provider evidence versions; customer tariffs remain in billing tables. */
export const providerModelRateVersions = sqliteTable(
	"provider_model_rate_versions",
	{
		id: text("id").primaryKey(),
		provider: text("provider").notNull(),
		modelId: text("model_id").notNull(),
		deploymentScope: text("deployment_scope").notNull(),
		/** Inclusive prompt input-token count; cached tokens are included. */
		inputTokenMin: integer("input_token_min").notNull().default(0),
		/** Exclusive upper bound, or null for an unbounded context class. */
		inputTokenMax: integer("input_token_max"),
		effectiveFrom: text("effective_from").notNull(),
		inputMicrousdPerMillion: integer("input_microusd_per_million").notNull(),
		outputMicrousdPerMillion: integer("output_microusd_per_million").notNull(),
		cacheReadMicrousdPerMillion: integer(
			"cache_read_microusd_per_million",
		).notNull(),
		cacheWriteMicrousdPerMillion: integer(
			"cache_write_microusd_per_million",
		).notNull(),
		currency: text("currency", { enum: ["USD"] }).notNull(),
		evidenceUri: text("evidence_uri").notNull(),
		evidenceDigest: text("evidence_digest").notNull(),
		verifiedAt: text("verified_at").notNull(),
		publishedAt: text("published_at").notNull(),
		publishedBy: text("published_by").notNull(),
		changeReason: text("change_reason").notNull(),
		supersedesRateVersionId: text("supersedes_rate_version_id").references(
			(): AnySQLiteColumn => providerModelRateVersions.id,
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
			sql`length(trim(${table.deploymentScope}, char(9) || char(10) || char(13) || ' ')) > 0`,
		),
		check(
			"chk_provider_model_rate_interval",
			sql`julianday(${table.effectiveFrom}) IS NOT NULL`,
		),
		check("chk_provider_model_rate_currency", sql`${table.currency} = 'USD'`),
		check(
			"chk_provider_model_rate_amounts",
			sql`typeof(${table.inputMicrousdPerMillion}) = 'integer' AND ${table.inputMicrousdPerMillion} BETWEEN 0 AND 9007199254740991 AND typeof(${table.outputMicrousdPerMillion}) = 'integer' AND ${table.outputMicrousdPerMillion} BETWEEN 0 AND 9007199254740991 AND typeof(${table.cacheReadMicrousdPerMillion}) = 'integer' AND ${table.cacheReadMicrousdPerMillion} BETWEEN 0 AND 9007199254740991 AND typeof(${table.cacheWriteMicrousdPerMillion}) = 'integer' AND ${table.cacheWriteMicrousdPerMillion} BETWEEN 0 AND 9007199254740991`,
		),
	],
);
export type ProviderModelRateVersionRow =
	typeof providerModelRateVersions.$inferSelect;
export type NewProviderModelRateVersionRow =
	typeof providerModelRateVersions.$inferInsert;
