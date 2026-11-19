export const IDENTITY_CACHE_TTL_MS = 15_000;

/** A live primary fence prevents stale entries in another Cloudflare location from granting access. */
export async function readCachedIdentity<T>(input: {
	cache: Pick<Cache, "match" | "put">;
	origin: string;
	scope: string;
	credential: string;
	readVersion: () => Promise<string | undefined>;
	load: () => Promise<T>;
	expiresAt: number;
	valueExpiresAt?: (value: T) => number;
	serialize?: (value: T) => T;
}): Promise<{ value: T; hit: boolean }> {
	const version = await input.readVersion();
	if (!version) return { value: await input.load(), hit: false };
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify([input.scope, input.credential])),
	);
	const hash = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	const key = new Request(
		`${input.origin}/__identity-cache/v1/${hash}/${encodeURIComponent(version)}`,
	);
	const cached = await input.cache.match(key).catch(() => undefined);
	if (cached) {
		const entry = (await cached.json()) as { expiresAt: number; value: T };
		if (
			entry.expiresAt > Date.now() &&
			input.expiresAt > Date.now() &&
			(input.valueExpiresAt?.(entry.value) ?? Infinity) > Date.now()
		)
			return { value: entry.value, hit: true };
	}
	const value = await input.load();
	const expiresAt = Math.min(
		Date.now() + IDENTITY_CACHE_TTL_MS,
		input.expiresAt,
		input.valueExpiresAt?.(value) ?? Infinity,
	);
	// A mutation during the load must never stamp old authority with a new version.
	if (
		value !== undefined &&
		expiresAt > Date.now() &&
		(await input.readVersion()) === version
	) {
		await input.cache
			.put(
				key,
				Response.json(
					{ expiresAt, value: input.serialize?.(value) ?? value },
					{
						headers: {
							"Cache-Control": `max-age=${Math.ceil((expiresAt - Date.now()) / 1000)}`,
						},
					},
				),
			)
			.catch(() => {});
	}
	return { value, hit: false };
}
