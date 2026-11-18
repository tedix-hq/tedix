interface BundleIdentity {
	version: number;
	etag: string;
}

export function isCmsDeployProbe(request: Request): boolean {
	return new URL(request.url).searchParams.has("_tedix_deploy");
}

/** Public read-only probes cannot certify a cached page or a different activation. */
export async function serveCmsDeployProbe(
	request: Request,
	bundle: BundleIdentity | null | undefined,
	readActive: () => Promise<BundleIdentity | null>,
	serve: () => Promise<Response>,
): Promise<Response> {
	const url = new URL(request.url);
	const matches = (active: BundleIdentity | null | undefined) =>
		Boolean(
			active &&
			String(active.version) === url.searchParams.get("_tedix_version") &&
			active.etag === url.searchParams.get("_tedix_etag"),
		);
	const conflict = () =>
		new Response("Deploy candidate is no longer active", {
			status: 409,
			headers: { "Cache-Control": "no-store" },
		});
	if (!matches(bundle)) return conflict();
	const response = await serve();
	if (!matches(await readActive())) {
		await response.body?.cancel();
		return conflict();
	}
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	headers.set("X-Tedix-Bundle-Version", String(bundle!.version));
	headers.set("X-Tedix-Bundle-Etag", bundle!.etag);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
