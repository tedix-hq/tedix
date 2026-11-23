/**
 * Messages to an organization's wallet Durable Object, which holds and charges
 * credits before D1 sees them. Served by the MCP worker; the API reaches it
 * over the `MCP_SERVICE` binding's `wallet` RPC.
 */

export type WalletRefusalCode =
	| "billing_not_configured"
	| "subscription_inactive"
	| "billing_period_inactive"
	| "monthly_credit_limit_reached"
	| "tedi_monthly_credit_cap_reached"
	| "member_monthly_credit_cap_reached";

/** Hold estimated credits for one model call before it is sent. */
export interface WalletHoldInput {
	organizationId: string;
	holdId: string;
	/** A retried admission with the same key gets the same hold. */
	idempotencyKey: string;
	tediId: string | null;
	userId: string | null;
	credits: number;
	expiresAt: string;
	/** Returned on settlement and kept on the call's charge (e.g. workspace chat). */
	runId?: string | null;
	metadata?: Record<string, unknown>;
}

export type WalletHoldResult =
	| {
			allowed: true;
			holdId: string;
			credits: number;
			expiresAt: string;
			/** An earlier admission with the same key already holds these credits. */
			replayed: boolean;
	  }
	| { allowed: false; code: WalletRefusalCode };

/** Turn a hold into a charge for the call's actual provider cost. */
export interface WalletSettleHoldInput {
	holdId: string;
	providerCostMicros: number;
}

export type WalletSettleHoldResult =
	| {
			found: true;
			credits: number;
			periodStart: string;
			periodEnd: string;
			runId: string | null;
			metadata: Record<string, unknown>;
	  }
	/** No such hold: a pre-wallet D1 reservation, or one pruned after expiry. */
	| { found: false };

/** The MCP worker's internal RPC, reached only through a service binding. */
export interface WalletRpc {
	wallet(
		organizationId: string,
		route: "hold" | "release" | "settle-hold",
		body: WalletHoldInput | { holdId: string } | WalletSettleHoldInput,
	): Promise<unknown>;
}
