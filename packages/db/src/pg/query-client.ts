import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

export type PgQueryClient = PgAsyncDatabase<PgQueryResultHKT>;
