import worker from "../src/index";

export const EDGE_TEDI = {
	id: "tedi-1",
	slug: "acme",
	organizationId: "org-1",
	runtimeKind: "agent",
	isolateAgentId: "isolate-acme",
	status: "active",
	descopeMcpResourceId: null,
	organizationDescopeTenantId: null,
} as const;

export interface EdgeRun {
	response: Response;
	/** Every request the edge forwarded to the tedi's Durable Object, in order. */
	forwarded: Request[];
	/** The DO names the edge addressed, in order. */
	doNames: string[];
}

/**
 * Drive the runtime Worker's real `fetch` for one tedi. D1 answers the slug
 * lookup with {@link EDGE_TEDI}; the tedi DO namespace records each forwarded
 * request and answers with `doResponse`.
 */
export async function edgeFetch(
	request: Request,
	options: {
		env?: Record<string, unknown>;
		doResponse?: (request: Request) => Response | Promise<Response>;
	} = {},
): Promise<EdgeRun> {
	const forwarded: Request[] = [];
	const doNames: string[] = [];
	const db = {
		prepare: () => ({
			bind: () => ({
				first: async () => EDGE_TEDI,
				all: async () => ({ results: [] }),
				run: async () => ({ success: true }),
			}),
		}),
	};
	const env = {
		DB: db,
		TEDI_AGENT: {
			idFromName: (name: string) => {
				doNames.push(name);
				return { name };
			},
			get: () => ({
				fetch: async (forwardedRequest: Request) => {
					forwarded.push(forwardedRequest);
					return options.doResponse
						? options.doResponse(forwardedRequest)
						: Response.json({ ok: true });
				},
			}),
		},
		...options.env,
	};
	const response = await worker.fetch(
		request,
		env as unknown as Cloudflare.Env,
	);
	return { response, forwarded, doNames };
}

/** A request addressed to {@link EDGE_TEDI}'s public hostname. */
export function tediRequest(
	path: string,
	init: RequestInit & { serviceBinding?: boolean } = {},
): Request {
	const { serviceBinding, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (serviceBinding) headers.set("X-Service-Binding", "true");
	return new Request(`https://${EDGE_TEDI.slug}.tedi.tedix.dev${path}`, {
		...rest,
		headers,
	});
}
