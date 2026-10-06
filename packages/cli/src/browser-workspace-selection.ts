import * as http from "node:http";
import { renderLoopbackPage } from "./loopback-page";

const DEFAULT_SELECTION_URL = "https://os.tedix.dev/cli/login";
// The browser now includes permission review and multiple organization choices.
const DEFAULT_TIMEOUT_MS = 600_000;
const ORGANIZATION_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const DESCOPE_TENANT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const SCOPE_RE =
	/^(?:mcp:[a-z0-9_-]+\.(?:read|write|admin)|connections\.(?:execute|admin)|platform:admin)$/;

export interface BrowserWorkspaceSelection {
	organization: string;
	tenant: string;
	organizations: Array<{ organization: string; tenant: string }>;
	scopes?: string[];
}

export interface BrowserWorkspaceSelectionSession extends BrowserWorkspaceSelection {
	/** Continue the already-open browser tab into the OAuth authorization step. */
	continueInBrowser: (authorizationUrl: string) => void;
}

const CONTINUING_HTML = renderLoopbackPage({
	title: "Tedix CLI",
	heading: "Preparing secure authorization",
	body: "Keep this tab open. Tedix is resolving your organization and will continue automatically.",
}).replace(
	"</body>",
	`<script>
		const state = new URLSearchParams(location.search).get("state");
		const poll = async () => {
			try {
				const response = await fetch("/continue?state=" + encodeURIComponent(state || ""), {
					cache: "no-store",
				});
				if (response.status === 204) return void setTimeout(poll, 150);
				if (!response.ok) throw new Error("authorization preparation failed");
				const body = await response.json();
				if (typeof body.authorizationUrl !== "string") throw new Error("invalid authorization response");
				location.replace(body.authorizationUrl);
			} catch {
				setTimeout(poll, 500);
			}
		};
		void poll();
	</script></body>`,
);

const ERROR_HTML = renderLoopbackPage({
	title: "Tedix CLI Error",
	heading: "Organization selection failed",
	body: "Return to your terminal and try again.",
	tone: "error",
});

export function buildBrowserWorkspaceSelectionUrl(options: {
	baseUrl?: string;
	organization?: string;
	port: number;
	state: string;
}): string {
	const url = new URL(options.baseUrl ?? DEFAULT_SELECTION_URL);
	url.searchParams.set("port", String(options.port));
	url.searchParams.set("state", options.state);
	if (options.organization) {
		url.searchParams.set("organization", options.organization);
	}
	return url.toString();
}

export function parseBrowserWorkspaceSelection(
	rawUrl: string,
	expectedState: string,
): BrowserWorkspaceSelection | null {
	const url = new URL(rawUrl, "http://127.0.0.1");
	if (url.pathname !== "/workspace") return null;
	if (url.searchParams.get("state") !== expectedState) return null;
	const organization = url.searchParams.get("organization")?.trim() ?? "";
	const tenant = url.searchParams.get("tenant")?.trim() ?? "";
	if (
		!ORGANIZATION_SLUG_RE.test(organization) ||
		!DESCOPE_TENANT_ID_RE.test(tenant)
	)
		return null;
	const orgs = url.searchParams.getAll("selected_org");
	const tenants = url.searchParams.getAll("selected_tenant");
	if (orgs.length !== tenants.length || orgs.length > 50) return null;
	const organizations = orgs.length
		? orgs.map((selected, index) => ({
				organization: selected,
				tenant: tenants[index] ?? "",
			}))
		: [{ organization, tenant }];
	if (
		organizations[0]?.organization !== organization ||
		organizations[0]?.tenant !== tenant ||
		organizations.some(
			(item) =>
				!ORGANIZATION_SLUG_RE.test(item.organization) ||
				!DESCOPE_TENANT_ID_RE.test(item.tenant),
		) ||
		new Set(organizations.map((item) => item.tenant)).size !==
			organizations.length
	)
		return null;
	const scopes = url.searchParams.getAll("scope");
	if (
		scopes.length > 100 ||
		new Set(scopes).size !== scopes.length ||
		scopes.some((scope) => !SCOPE_RE.test(scope))
	)
		return null;
	return {
		organization,
		tenant,
		organizations,
		...(scopes.length ? { scopes } : {}),
	};
}

/**
 * Open the authenticated Tedix OS launcher and wait for one membership-scoped
 * organization choice to return to a one-time loopback callback.
 */
export function selectWorkspaceInBrowser(options: {
	baseUrl?: string;
	openBrowser: (url: string) => void;
	organization?: string;
	port?: number;
	state?: string;
	timeoutMs?: number;
}): Promise<BrowserWorkspaceSelectionSession> {
	const requestedPort = options.port ?? 0;
	const state = options.state ?? crypto.randomUUID();

	return new Promise<BrowserWorkspaceSelectionSession>((resolve, reject) => {
		let settled = false;
		let authorizationUrl: string | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const close = () => {
			if (timer) clearTimeout(timer);
			server.close();
		};
		const settle = (result: BrowserWorkspaceSelection | Error) => {
			if (settled) return;
			settled = true;
			if (result instanceof Error) {
				close();
				reject(result);
				return;
			}
			resolve({
				...result,
				continueInBrowser: (nextUrl) => {
					if (authorizationUrl) return;
					const parsed = new URL(nextUrl);
					if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
						close();
						throw new Error(
							"Refusing to continue CLI authorization to an unsafe URL.",
						);
					}
					authorizationUrl = parsed.toString();
				},
			});
		};
		const server = http.createServer((request, response) => {
			const requestUrl = new URL(request.url ?? "", "http://127.0.0.1");
			if (requestUrl.pathname === "/continue") {
				if (requestUrl.searchParams.get("state") !== state || !settled) {
					response.writeHead(400, { "Cache-Control": "no-store" });
					response.end();
					return;
				}
				if (!authorizationUrl) {
					response.writeHead(204, { "Cache-Control": "no-store" });
					response.end();
					return;
				}
				response.writeHead(200, {
					"Cache-Control": "no-store",
					"Content-Type": "application/json; charset=utf-8",
				});
				response.end(JSON.stringify({ authorizationUrl }));
				close();
				return;
			}
			const selection = parseBrowserWorkspaceSelection(
				request.url ?? "",
				state,
			);
			if (!selection) {
				response.writeHead(400, {
					"Cache-Control": "no-store",
					"Content-Type": "text/html; charset=utf-8",
				});
				response.end(ERROR_HTML);
				return;
			}
			response.writeHead(200, {
				"Cache-Control": "no-store",
				"Content-Type": "text/html; charset=utf-8",
			});
			response.end(CONTINUING_HTML);
			settle(selection);
		});
		server.on("error", (error) => settle(error));
		server.listen(requestedPort, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				settle(new Error("Could not determine the CLI callback port."));
				return;
			}
			options.openBrowser(
				buildBrowserWorkspaceSelectionUrl({
					baseUrl: options.baseUrl ?? process.env.TEDIX_LOGIN_URL,
					...(options.organization
						? { organization: options.organization }
						: {}),
					port: address.port,
					state,
				}),
			);
		});

		timer = setTimeout(() => {
			if (settled) {
				close();
				return;
			}
			settle(
				new Error(
					`No organization was selected within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1_000)} seconds.`,
				),
			);
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		timer.unref();
	});
}
