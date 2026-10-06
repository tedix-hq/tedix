/**
 * Shared SQL helpers for Drizzle column DEFAULTs.
 *
 * The original UUID DEFAULT used pure `randomblob` chunks — fast but it
 * doesn't set the version (3rd group nibble) or variant (4th group nibble)
 * bits, so the resulting strings are 36-char "UUID-shaped" but not standards-
 * compliant. Zod's `z.string().uuid()` rejects them, which broke
 * `app.update_app_tool` for old rows in 2026-05.
 *
 * `uuid4Default()` returns a SQL fragment that produces RFC 4122 v4 UUIDs:
 *   - 3rd group: starts with literal "4" (version)
 *   - 4th group: starts with one of [8,9,a,b] (variant)
 *
 * Use it as the column default for any text PK that should be a v4 UUID:
 *   id: text("id").primaryKey().default(uuid4Default()),
 */

import { type SQL, sql } from "drizzle-orm";

/**
 * v4-compliant UUID generator (SQLite-only — uses randomblob + random).
 */
export function uuid4Default(): SQL {
	return sql`(lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  ))`;
}
