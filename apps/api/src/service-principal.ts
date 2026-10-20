import { correlatedRequest } from "@tedix/worker-kit/request-correlation";

/** Request-local authority supplied by named Worker binding configuration. */
const principals = new WeakMap<Request, "mcp-edge">();

export function bindMcpServicePrincipal(request: Request): void {
	principals.set(request, "mcp-edge");
}

export function getServiceBindingPrincipal(
	request: Request,
): "mcp-edge" | undefined {
	return principals.get(request);
}

/** Correlation clones the request; preserve authority outside its headers. */
export function correlatedServiceRequest(original: Request) {
	const result = correlatedRequest(original);
	if (getServiceBindingPrincipal(original) === "mcp-edge") {
		bindMcpServicePrincipal(result.request);
	}
	return result;
}
