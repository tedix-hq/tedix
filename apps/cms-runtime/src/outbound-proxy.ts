import { isMarketingHost, marketingResponse } from "./marketing";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { Env } from "./index";
import {
	CmsRestoreFenceUnavailableError,
	withCmsRestorePermit,
} from "./tenant-restore-fence";
import {
	cmsEditorProposalFetchRequest,
	descopeJwksFetchRequest,
	isConfiguredDescopeJwksRequest,
	tenantEgressDecision,
} from "./tenant-egress-policy";

export interface CmsOutboundProxyProps {
	siteId: string;
	slug: string;
	restoreEpoch: number;
}

function logEgress(
	request: Request,
	decision: ReturnType<typeof tenantEgressDecision>,
	slug: string,
): void {
	console.log(
		JSON.stringify({
			event: "cms.tenant_egress",
			decision: decision.decision,
			host: decision.host,
			method: request.method,
			reason: decision.reason,
			slug,
		}),
	);
}

/**
 * Observable, SSRF-guarded global outbound service for CMS tenant isolates.
 * Tenant requests remain open to public HTTPS destinations, while private and
 * Tedix-internal targets fail before the parent Worker performs any fetch.
 */
export class CmsOutboundProxy extends WorkerEntrypoint<
	Env,
	CmsOutboundProxyProps
> {
	async fetch(request: Request): Promise<Response> {
		const permitted = await withCmsRestorePermit(
			createDbQueryClient(this.env.PLATFORM_DB),
			this.ctx.props,
			() => this.fetchPermitted(request),
		);
		if (!permitted.admitted) throw new CmsRestoreFenceUnavailableError();
		return permitted.value;
	}

	private async fetchPermitted(request: Request): Promise<Response> {
		if (
			this.ctx.props.slug === this.env.MARKETING_SITE_SLUG &&
			isMarketingHost(new URL(request.url).hostname, this.env)
		) {
			const response = await marketingResponse(request, this.env);
			if (response) return response;
		}
		if (
			isConfiguredDescopeJwksRequest(request, {
				baseUrl: this.env.DESCOPE_BASE_URL,
				projectId: this.env.DESCOPE_PROJECT_ID,
			})
		) {
			logEgress(
				request,
				{ decision: "allow", host: "auth.tedix.dev", reason: null },
				this.ctx.props.slug,
			);
			// The tenant supplies only the URL. Its cookies, credentials, and custom
			// headers cannot ride the parent fetch to the identity provider.
			return fetch(descopeJwksFetchRequest(request));
		}
		const proposalRequest = await cmsEditorProposalFetchRequest(
			request,
			this.ctx.props.siteId,
		);
		if (proposalRequest) {
			logEgress(
				request,
				{ decision: "allow", host: "api.tedix.dev", reason: null },
				this.ctx.props.slug,
			);
			return fetch(proposalRequest);
		}
		const decision = tenantEgressDecision(request.url);
		if (decision.decision === "deny") {
			logEgress(request, decision, this.ctx.props.slug);
			return Response.json(
				{
					ok: false,
					code: "tenant_egress_blocked",
					reason: decision.reason,
				},
				{ status: 403 },
			);
		}

		logEgress(request, decision, this.ctx.props.slug);

		// Do not let an upstream redirect escape the URL-level policy. Returning
		// the 3xx lets tenant code deliberately issue a second, separately
		// validated request when it chooses to follow the Location header.
		return fetch(new Request(request, { redirect: "manual" }));
	}
}
