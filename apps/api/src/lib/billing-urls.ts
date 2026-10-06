export type BillingReturnState =
	| "success"
	| "cancelled"
	| "topup-success"
	| "topup-cancelled";

/**
 * Canonical destination for organization billing flows: Tedix OS
 * `/admin/billing`. OS tenancy is hostname-based (`{slug}.os.tedix.dev`
 * resolves the organization), so there is no slug path segment — but the OS client normally passes its own tenant-origin
 * successUrl/cancelUrl/returnUrl, so this default mostly covers non-OS
 * callers and older clients.
 *
 * The `state` param drives the OS return handshake
 * (`?checkout=success|cancelled|topup-success|topup-cancelled` — invalidate the billing reads, show a
 * notice). Both URLs feed the Stripe checkout idempotency key
 * (`stripeCheckoutIdempotencyKey`), so changing this shape rotates those keys.
 */
export function buildBillingSettingsUrl(input: {
	osUrl: string;
	state?: BillingReturnState;
}): string {
	const url = new URL("/admin/billing", input.osUrl);
	if (input.state) url.searchParams.set("checkout", input.state);
	return url.toString();
}
