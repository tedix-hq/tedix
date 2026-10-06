import { RPCLink } from "@orpc/client/fetch";

/** RPCLink always passes a string URL, which is what `ctx.http.fetch` takes. */
export type PlatformFetch = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Official oRPC transport shared by independently published Emdash plugins.
 *
 * The deployment adapter owns only URL/auth wiring while RPCLink owns the v2
 * request envelope and response decoding.
 */
export async function callPlatformRpc<TOutput>(
	apiUrl: string,
	path: readonly string[],
	input: unknown,
	apiKey: string,
	fetch: PlatformFetch,
): Promise<TOutput> {
	const target = new URL(`${apiUrl.replace(/\/+$/, "")}/rpc`);
	const link = new RPCLink({
		origin: target.origin,
		url: target.pathname as `/${string}`,
		headers: { Authorization: `Bearer ${apiKey}` },
		fetch,
	});

	return (await link.call([...path], input, { context: {} })) as TOutput;
}

/** Authenticated editor call to the locked platform origin; no plugin settings or actor claims. */
export async function callEditorPlatformRpc<TOutput>(
	apiUrl: string,
	path: readonly string[],
	input: unknown,
	session: string,
	fetch: PlatformFetch,
): Promise<TOutput> {
	const target = new URL(apiUrl);
	if (
		target.protocol !== "https:" ||
		target.username ||
		target.password ||
		target.search ||
		target.hash
	)
		throw new Error("Invalid platform API origin");
	const link = new RPCLink({
		origin: target.origin,
		url: "/rpc",
		headers: { Authorization: `Bearer ${session}` },
		fetch,
	});
	return (await link.call([...path], input, { context: {} })) as TOutput;
}
