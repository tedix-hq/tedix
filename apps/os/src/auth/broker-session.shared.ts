export const OS_BROKER_RENEWAL_WINDOW_SECONDS = 60;

/**
 * Broker-owned product sessions renew before hard expiry through the one
 * auth-host rotation owner.
 */
export function isOsBrokerSessionRenewalDue(
	expiresAt: number | undefined,
	nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
	return (
		typeof expiresAt === "number" &&
		expiresAt <= nowSeconds + OS_BROKER_RENEWAL_WINDOW_SECONDS
	);
}
