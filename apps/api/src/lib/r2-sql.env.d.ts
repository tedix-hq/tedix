/**
 * Optional env augmentation for the R2 SQL (R2 Data Catalog / Iceberg) payload
 * read path.
 *
 * CF_R2_SQL_TOKEN is an optional runtime Worker secret. The read path falls
 * back to CF_ANALYTICS_TOKEN when it is absent, so it must not be added to
 * wrangler `secrets.required`.
 *
 * R2_SQL_WAREHOUSE and R2_SQL_TABLE are Wrangler vars owned by the generated
 * `worker-configuration.d.ts`; do not redeclare them here. An optional string
 * augmentation weakens their generated required string-literal types.
 */
interface CloudflareEnv {
	CF_R2_SQL_TOKEN?: string;
}
