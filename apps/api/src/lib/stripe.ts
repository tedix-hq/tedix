/** Stripe client. Prices are resolved by lookup key (see stripe-billing.ts). */

import type Stripe from "stripe";

// =============================================================================
// STRIPE CLIENT
// =============================================================================

const stripeClients = new Map<string, Stripe>();

/**
 * Async so the Stripe SDK stays OUT of the first-request module graph.
 *
 * A static `import Stripe from "stripe"` pulled 0.76 MB — 6.9% of the 11.2 MB
 * graph evaluated on the first request into every isolate — into startup, even
 * though the SDK is only ever constructed here, at request time, on billing and
 * webhook paths. Cloudflare charges that evaluation as first-request CPU, which
 * is the documented cold-start cost on this Worker. The client is still cached
 * across calls; only the module load moved.
 */
export async function getStripe(secretKey: string): Promise<Stripe> {
	let stripe = stripeClients.get(secretKey);
	if (!stripe) {
		const { default: Stripe } = await import("stripe");
		stripe = new Stripe(secretKey, {
			httpClient: Stripe.createFetchHttpClient(),
		});
		stripeClients.set(secretKey, stripe);
	}
	return stripe;
}
