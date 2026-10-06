const SERVICE_KEY_PREFIX = "_cms-service-keys/";

export async function loadServiceKey(
	storage: R2Bucket,
	orgSlug: string,
	staticKeys: Record<string, string>,
): Promise<string | undefined> {
	if (staticKeys[orgSlug]) return staticKeys[orgSlug];
	const object = await storage.get(`${SERVICE_KEY_PREFIX}${orgSlug}`);
	if (!object) return undefined;
	const key = (await object.text()).trim();
	return key || undefined;
}

export async function storeServiceKey(
	storage: R2Bucket,
	orgSlug: string,
	pat: string,
): Promise<void> {
	await storage.put(`${SERVICE_KEY_PREFIX}${orgSlug}`, pat);
}
