import * as jose from "jose";

const ISSUER = "tedix:home-delegated-mcp";
const TYPE = "tedix-delegated-mcp+jwt";
const MAX_LIFETIME_SECONDS = 180;

export interface DelegatedMcpClaims {
	runId: string;
	homeRunId: string;
	workItemId: string;
	tediId: string;
	organizationId: string;
	scopes: string[];
	audience: string;
}

function key(secret: string): Uint8Array {
	if (!secret) throw new Error("Delegated MCP signing secret is unavailable");
	// The platform service secret is shared by the API issuer and MCP verifier.
	// Keep this JWT's signing key cryptographically separate from other uses.
	return new TextEncoder().encode(`tedix:delegated-mcp:v1:${secret}`);
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function assertClaims(value: Record<string, unknown>): DelegatedMcpClaims {
	const { runId, homeRunId, workItemId, tediId, organizationId, scopes, aud } =
		value;
	if (
		value.typ !== TYPE ||
		!nonempty(runId) ||
		!nonempty(homeRunId) ||
		!nonempty(workItemId) ||
		!nonempty(tediId) ||
		!nonempty(organizationId) ||
		!nonempty(aud) ||
		!Array.isArray(scopes) ||
		scopes.length > 64 ||
		!scopes.every((scope) => nonempty(scope)) ||
		scopes.some(
			(scope) =>
				scope === "*" ||
				scope === "mcp:*" ||
				(scope.startsWith("mcp:work.") && scope !== "mcp:work.read"),
		)
	)
		throw new Error("Invalid delegated MCP claims");
	return {
		runId,
		homeRunId,
		workItemId,
		tediId,
		organizationId,
		scopes,
		audience: aud,
	};
}

export async function issueDelegatedMcpToken(
	input: DelegatedMcpClaims & { secret: string; now?: number },
): Promise<{ token: string; expiresAt: number }> {
	const now = input.now ?? Math.floor(Date.now() / 1000);
	const claims = assertClaims({ ...input, aud: input.audience, typ: TYPE });
	const expiresAt = now + MAX_LIFETIME_SECONDS;
	const token = await new jose.SignJWT({
		typ: TYPE,
		runId: claims.runId,
		homeRunId: claims.homeRunId,
		workItemId: claims.workItemId,
		tediId: claims.tediId,
		organizationId: claims.organizationId,
		scopes: claims.scopes,
	})
		.setProtectedHeader({ alg: "HS256", typ: TYPE })
		.setIssuer(ISSUER)
		.setAudience(claims.audience)
		.setIssuedAt(now)
		.setNotBefore(now)
		.setExpirationTime(expiresAt)
		.sign(key(input.secret));
	return { token, expiresAt };
}

export async function verifyDelegatedMcpToken(
	token: string,
	options: { secret: string; audience: string; now?: number },
): Promise<DelegatedMcpClaims> {
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const result = await jose.jwtVerify(token, key(options.secret), {
		issuer: ISSUER,
		audience: options.audience,
		algorithms: ["HS256"],
		currentDate: new Date(now * 1000),
		clockTolerance: 0,
	});
	if (
		result.protectedHeader.typ !== TYPE ||
		typeof result.payload.iat !== "number" ||
		typeof result.payload.exp !== "number" ||
		result.payload.iat > now ||
		result.payload.exp - result.payload.iat > MAX_LIFETIME_SECONDS
	) {
		throw new Error("Invalid delegated MCP lifetime");
	}
	return assertClaims(result.payload as Record<string, unknown>);
}

export function isDelegatedMcpToken(token: string): boolean {
	try {
		return jose.decodeProtectedHeader(token).typ === TYPE;
	} catch {
		return false;
	}
}

/** Defense in depth when a D1 tool's configured scope is accidentally broad. */
export function isDelegatedWorkTool(
	toolId: string,
	namespace: string,
	config?: Record<string, unknown> | null,
): boolean {
	const name = toolId.toLowerCase();
	const ns = namespace.toLowerCase();
	const rawName = name.includes("__")
		? name.split("__").slice(1).join("__")
		: name;
	const endpoint = config?.rpcEndpoint ?? config?.endpoint;
	const normalizedEndpoint =
		typeof endpoint === "string"
			? endpoint.trim().replace(/^\/+/, "").split(/[?#]/, 1)[0]?.toLowerCase()
			: null;
	const route = normalizedEndpoint?.split("/", 1)[0] ?? null;
	// These exact generated reads are safe for a supervised child whose token
	// carries mcp:work.read. Match the endpoint and canonical name together so a
	// mutation alias cannot become readable through misleading D1 annotations.
	// Base-app tools keep their source prefix (`tedix__...`) after aggregation;
	// aggregate-tedi tools carry provenance stamps that must agree exactly.
	const safeReadNamesByEndpoint: Record<string, ReadonlySet<string>> = {
		"workitems/list": new Set(["list_work_items", "work_items_list"]),
		"workitems/getbyid": new Set(["get_work_items_by_id", "work_item_get"]),
		"workitems/getreadiness": new Set(["get_work_item_readiness"]),
		"workitems/listattempts": new Set([
			"list_work_item_attempts",
			"list_work_attempts",
		]),
	};
	const safeNames = normalizedEndpoint
		? safeReadNamesByEndpoint[normalizedEndpoint]
		: undefined;
	if (safeNames?.has(rawName)) {
		const aggregateNamespace = config?._aggregateNamespace;
		const aggregateRemoteName = config?._aggregateTediRemoteName;
		if (aggregateNamespace === undefined && aggregateRemoteName === undefined) {
			if (ns === "work") return false;
		} else if (
			aggregateNamespace === namespace &&
			aggregateRemoteName === rawName
		) {
			return false;
		}
	}
	return (
		route === "workitems" ||
		route === "workitem" ||
		ns === "work" ||
		ns === "work_item" ||
		ns === "work_items" ||
		// A supervised child cannot spawn a second Home/kernel path to reacquire
		// ambient Work authority through the aggregate MCP surface.
		ns === "home" ||
		ns === "kernel" ||
		/(^|[_:.])work_items?([_:.]|$)/.test(name) ||
		/(^|[_:.])assigned_work([_:.]|$)/.test(name) ||
		/(^|[_:.])(work_attempt|work_evidence|work_graph|work_approval)([_:.]|$)/.test(
			name,
		) ||
		/^(complete_work_item|heartbeat_work_attempt|settle_work_attempt|start_work_attempt|submit_work_evidence|decide_work_approval)$/.test(
			name,
		)
	);
}
