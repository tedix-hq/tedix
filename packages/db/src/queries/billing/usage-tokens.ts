/**
 * Shared token-usage expression for the daily inference capacity gates.
 *
 * A reservation's estimate is the only number available while it is in
 * flight, but once it settles the charge row carries the provider-reported
 * tokens. Gates that keep summing the estimate for settled rows over-count
 * by the flat `estimated_output_tokens`, so
 * every daily token sum uses this expression instead.
 */

import { type SQL, sql } from "drizzle-orm";

/**
 * Tokens one `billing_usage_reservations` row contributes to a daily gate:
 * the actual `input_tokens + output_tokens` of its charge row(s) once settled,
 * otherwise (in flight, or settled but not yet reconciled) its estimate.
 *
 * `reservationAlias` must be the alias of the `billing_usage_reservations`
 * table in the enclosing FROM clause. The correlated subquery is aliased
 * `charge`, so the caller must not reuse that name in the same scope.
 */
export function reservationUsedTokensSql(reservationAlias: string): SQL {
	const reservation = sql.raw(reservationAlias);
	const estimate = sql`${reservation}.estimated_input_tokens + ${reservation}.estimated_output_tokens`;
	return sql`CASE
		WHEN ${reservation}.status = 'settled' THEN COALESCE((
			SELECT SUM(charge.input_tokens + charge.output_tokens)
			FROM billing_usage_charges AS charge
			WHERE charge.reservation_id = ${reservation}.id
		), ${estimate})
		ELSE ${estimate}
	END`;
}
