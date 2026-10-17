import {
	callRpc,
	RpcCallError,
	serviceBindingFetch,
	type FetcherLike,
} from "@tedix/api-client/internal";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
const cookie = "__Host-tedix-tedi-console";
type ConsoleSnapshot = {
	tediId: string;
	name: string;
	readOnly: true;
	workspaces: { id: string; name: string; description: string | null }[];
	outputs: { id: string; title: string; kind: string }[];
};
function escape(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
export async function handleTediConsole(
	request: Request,
	api: FetcherLike | undefined,
	tenantId: string | null,
): Promise<Response> {
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Referrer-Policy": "no-referrer",
		"X-Robots-Tag": "noindex, nofollow, noarchive",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
	});
	if (!api || !tenantId)
		return new Response("Open the tedi console on an organization hostname.", {
			status: 404,
			headers,
		});
	const url = new URL(request.url);
	const installing = url.pathname === "/tedi-console/session";
	if (request.method !== (installing ? "POST" : "GET"))
		return new Response("Method Not Allowed", { status: 405, headers });
	// Session installation requires an explicit bearer token, never ambient human authentication.
	const token = installing
		? request.headers.get("Authorization")?.match(/^Bearer (tcs_\S+)$/i)?.[1]
		: resolveProductSession(request.headers.get("Cookie"), cookie);
	if (!token?.startsWith("tcs_"))
		return new Response("A tedi console session is required.", {
			status: 401,
			headers,
		});
	try {
		const snapshot = await callRpc<ConsoleSnapshot>(
			"tediConsole/read",
			installing
				? {}
				: { workspaceId: url.searchParams.get("workspace") ?? undefined },
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(api),
				headers: {
					Authorization: `Bearer ${token}`,
					"X-Tedix-Tenant-Id": tenantId,
				},
				retry: 0,
			},
		);
		if (installing) {
			headers.append(
				"Set-Cookie",
				`${cookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`,
			);
			headers.set("Location", "/tedi-console");
			return new Response(null, { status: 303, headers });
		}
		headers.set("Content-Type", "text/html; charset=utf-8");
		return new Response(
			`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(snapshot.name)} · Tedix OS</title><style>body{font:16px system-ui;margin:0;background:#f7f7f5;color:#18201c}main{max-width:960px;margin:4rem auto;padding:2rem}a{color:#245e44}li{margin:1rem 0}header{border-bottom:1px solid #ccd3cb;padding-bottom:1rem}.badge{display:inline-block;padding:.35rem .7rem;border-radius:2rem;background:#e1ebe2}small{color:#56615a}</style></head><body><main><header><small>TEDIX OS · TEDI CONSOLE</small><h1>${escape(snapshot.name)}</h1><span class="badge">Read-only</span><p>Signed in as this tedi. Every read is recorded under its identity.</p></header><h2>Workspaces</h2><ul>${snapshot.workspaces.map((w) => `<li><a href="/tedi-console?workspace=${encodeURIComponent(w.id)}">${escape(w.name)}</a>${w.description ? `<p>${escape(w.description)}</p>` : ""}</li>`).join("")}</ul>${url.searchParams.has("workspace") ? `<h2>Outputs</h2><ul>${snapshot.outputs.map((o) => `<li>${escape(o.title)} <small>${escape(o.kind)}</small></li>`).join("") || "<li>No outputs in this Workspace.</li>"}</ul>` : ""}<p>Changes require the existing governed approval flow. This session cannot edit, execute, approve or grant access.</p><small>Sessions expire after five minutes. Request a fresh session to continue.</small></main></body></html>`,
			{ headers },
		);
	} catch (error) {
		const status =
			error instanceof RpcCallError && error.status >= 400 && error.status < 500
				? error.status
				: 503;
		return new Response(
			status === 503
				? "Console temporarily unavailable."
				: "Console access refused or expired.",
			{ status, headers },
		);
	}
}
