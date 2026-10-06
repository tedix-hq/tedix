import type { TedixMcpRuntimeBinding } from "@tedix/mcp-client-core/runtime";
import { AgentMcpRuntime } from "./mcp-client-runtime";
import { resolveBrainBridgePlatformClient } from "./platform-client-factory";

const EMBEDDED_WORK_COMMENT_ROLES = new Set([
	"owner",
	"admin",
	"administrator",
	"manager",
]);

const EMBEDDED_WORK_CALLABLES = {
	list: "work.list_work_items",
	events: "work.list_work_item_events",
	comment: "work.add_comment",
} as const;

interface RawEmbeddedWorkItem {
	id?: unknown;
	title?: unknown;
	description?: unknown;
	disposition?: unknown;
	accountableOwnerId?: unknown;
	stewardId?: unknown;
	priority?: unknown;
	updatedAt?: unknown;
	createdAt?: unknown;
	metadata?: unknown;
	provenance?: unknown;
	sourceSessionKey?: unknown;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Find the data rows inside either a direct oRPC result or an MCP content
 * envelope. The gateway legitimately returns both shapes depending on the
 * selected transport; the projection must fail closed for every other shape.
 */
export function embeddedPortableRows(value: unknown, depth = 0): unknown[] {
	if (typeof value === "string" && depth <= 8) {
		try {
			return embeddedPortableRows(JSON.parse(value), depth + 1);
		} catch {
			return [];
		}
	}
	if (Array.isArray(value)) {
		let sawTextEnvelope = false;
		for (const item of value) {
			if (record(item).type === "text") {
				sawTextEnvelope = true;
				const rows = embeddedPortableRows(record(item).text, depth + 1);
				if (rows.length) return rows;
			}
		}
		return sawTextEnvelope ? [] : value;
	}
	if (!value || typeof value !== "object" || depth > 8) return [];
	const object = record(value);
	if (Array.isArray(object.data)) return object.data;
	for (const key of [
		"result",
		"value",
		"structuredContent",
		"output",
		"content",
	]) {
		const rows = embeddedPortableRows(object[key], depth + 1);
		if (rows.length) return rows;
	}
	return [];
}

/** Internal execution records are private unless explicitly projected. */
export function isEmbeddedCustomerVisibleWorkItem(
	item: RawEmbeddedWorkItem,
): boolean {
	const metadata = record(item.metadata);
	if (metadata.customerVisible === true) return true;
	if (metadata.customerVisible === false) return false;

	const provenance = record(item.provenance);
	if (provenance.source === "kernelRuntime.directDelegation") return false;
	if (metadata.agentHarness || metadata.agentSession || metadata.homeRunId)
		return false;
	if (String(item.sourceSessionKey || "").startsWith("agent:")) return false;
	if (String(metadata.purposeContext || "").startsWith("transitional_"))
		return false;
	return !String(item.title || "")
		.trimStart()
		.startsWith("[[tedix-context");
}

/**
 * The only Work Item fields an embedded browser may receive. In particular,
 * provenance, source-session keys, execution metadata, acceptance contracts,
 * and internal actor ids never cross this server boundary.
 */
export function projectEmbeddedCustomerWorkItem(item: RawEmbeddedWorkItem) {
	const metadata = record(item.metadata);
	return {
		id: String(item.id || ""),
		title: String(item.title || ""),
		description: typeof item.description === "string" ? item.description : "",
		disposition:
			typeof item.disposition === "string" ? item.disposition : "proposed",
		accountableOwnerId:
			typeof item.accountableOwnerId === "string"
				? item.accountableOwnerId
				: null,
		stewardId: typeof item.stewardId === "string" ? item.stewardId : null,
		priority: typeof item.priority === "string" ? item.priority : "medium",
		updatedAt:
			typeof item.updatedAt === "string"
				? item.updatedAt
				: typeof item.createdAt === "string"
					? item.createdAt
					: null,
		createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
		metadata:
			typeof metadata.hostDeepLink === "string"
				? { hostDeepLink: metadata.hostDeepLink }
				: {},
	};
}

export function projectEmbeddedCustomerWorkResult(value: unknown): {
	data: ReturnType<typeof projectEmbeddedCustomerWorkItem>[];
	pagination: { total: number; hasMore: boolean };
} {
	const data = embeddedPortableRows(value)
		.filter((item) => isEmbeddedCustomerVisibleWorkItem(record(item)))
		.map((item) => projectEmbeddedCustomerWorkItem(record(item)));
	return {
		data,
		pagination: { total: data.length, hasMore: false },
	};
}

const EMBEDDED_WORK_RAW_PAGE_SIZE = 25;
const EMBEDDED_WORK_MAX_SCAN = 100;

/** Translate browser paging into a bounded page over visible rows, not raw rows. */
async function listEmbeddedCustomerWork(input: {
	args: Record<string, unknown>;
	execute: (
		callable: string,
		args: Record<string, unknown>,
	) => Promise<unknown>;
}): Promise<ReturnType<typeof projectEmbeddedCustomerWorkResult>> {
	const requestedLimit = Math.min(
		Math.max(Math.trunc(Number(input.args.limit) || 20), 1),
		20,
	);
	const requestedOffset = Math.max(
		Math.trunc(Number(input.args.offset) || 0),
		0,
	);
	const target = requestedOffset + requestedLimit + 1;
	const visible: ReturnType<typeof projectEmbeddedCustomerWorkItem>[] = [];
	let rawOffset = 0;
	let rawExhausted = false;
	const { limit: _limit, offset: _offset, ...filters } = input.args;

	while (
		rawOffset < EMBEDDED_WORK_MAX_SCAN &&
		visible.length < target &&
		!rawExhausted
	) {
		const raw = await input.execute(EMBEDDED_WORK_CALLABLES.list, {
			...filters,
			limit: EMBEDDED_WORK_RAW_PAGE_SIZE,
			offset: rawOffset,
		});
		const rows = embeddedPortableRows(raw);
		visible.push(
			...rows
				.filter((item) => isEmbeddedCustomerVisibleWorkItem(record(item)))
				.map((item) => projectEmbeddedCustomerWorkItem(record(item))),
		);
		rawExhausted = rows.length < EMBEDDED_WORK_RAW_PAGE_SIZE;
		rawOffset += rows.length;
		if (rows.length === 0) rawExhausted = true;
	}

	return {
		data: visible.slice(requestedOffset, requestedOffset + requestedLimit),
		pagination: {
			total: visible.length,
			hasMore:
				visible.length > requestedOffset + requestedLimit || !rawExhausted,
		},
	};
}

function workItemId(args: Record<string, unknown>): string {
	const id = typeof args.id === "string" ? args.id.trim() : "";
	if (!id) throw new Error("Embedded Work operation requires a Work Item id");
	return id;
}

/** Signed Tedi/session authority owns tenant selection; browser args never do. */
function withoutCallerTenantSelectors(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const {
		orgId: _orgId,
		organizationId: _organizationId,
		tenantId: _tenantId,
		tediId: _tediId,
		...bounded
	} = args;
	return bounded;
}

async function requireEmbeddedCustomerWorkItem(input: {
	execute: (
		callable: string,
		args: Record<string, unknown>,
	) => Promise<unknown>;
	authority: { allowedCallables: readonly string[] };
	id: string;
}): Promise<ReturnType<typeof projectEmbeddedCustomerWorkItem>> {
	if (
		!input.authority.allowedCallables.includes(EMBEDDED_WORK_CALLABLES.list)
	) {
		throw new Error("Embedded Work visibility check is not admitted");
	}
	const result = projectEmbeddedCustomerWorkResult(
		await input.execute(EMBEDDED_WORK_CALLABLES.list, {
			idPrefix: input.id,
			limit: 1,
		}),
	);
	const item = result.data.find((candidate) => candidate.id === input.id);
	if (!item) throw new Error("Work Item is not customer-visible");
	return item;
}

/**
 * Apply the server-owned embedded Work boundary around the otherwise generic
 * MCP callable. Reads return allowlisted DTOs; event preparation returns only
 * the addressed visible item; writes first prove the target is visible.
 */
export async function executeEmbeddedPortableCall(input: {
	callable: string;
	args: Record<string, unknown>;
	authority: {
		allowedCallables: readonly string[];
		hostOrganizationId: string;
		hostUserId: string;
		hostUserLabel?: string;
		hostRole?: string;
	};
	execute: (
		callable: string,
		args: Record<string, unknown>,
	) => Promise<unknown>;
}): Promise<unknown> {
	const tenantBoundArgs = withoutCallerTenantSelectors(input.args);
	if (input.callable === EMBEDDED_WORK_CALLABLES.list) {
		return listEmbeddedCustomerWork({
			args: tenantBoundArgs,
			execute: input.execute,
		});
	}
	if (
		input.callable === EMBEDDED_WORK_CALLABLES.events ||
		input.callable === EMBEDDED_WORK_CALLABLES.comment
	) {
		const item = await requireEmbeddedCustomerWorkItem({
			execute: input.execute,
			authority: input.authority,
			id: workItemId(tenantBoundArgs),
		});
		if (input.callable === EMBEDDED_WORK_CALLABLES.events) {
			return { data: [item], pagination: { total: 1, hasMore: false } };
		}
	}
	return input.execute(
		input.callable,
		embeddedPortableArgs(input.callable, tenantBoundArgs, input.authority),
	);
}

export async function executeEmbeddedPortableTool(input: {
	embeddedSessionToken?: string;
	env: Cloudflare.Env;
	tediId: string;
	orgId: string;
	authority: {
		hostOrganizationId: string;
		hostUserId: string;
		hostUserLabel?: string;
		hostRole?: string;
		hostTenantArgument: string;
		hostTenantNamespace: string;
		sessionKey: string;
		allowedCallables: readonly string[];
	};
	callable: string;
	args: Record<string, unknown>;
	signal?: AbortSignal;
}): Promise<unknown> {
	assertPortableCallable(input.callable, input.authority);
	const runtime = new AgentMcpRuntime(input.env, input.tediId, input.orgId);
	await runtime.ensureSynced();
	const platform = await resolveBrainBridgePlatformClient({
		env: input.env,
		tediId: input.tediId,
		orgId: input.orgId,
	});
	if (!platform) throw new Error("Portable tool platform unavailable");
	const binding: TedixMcpRuntimeBinding & { platform: typeof platform } = {
		conversationId: `embedded-webmcp:${input.authority.sessionKey}`,
		runId: `${input.tediId}:embedded-webmcp:${crypto.randomUUID()}`,
		traceId: crypto.randomUUID(),
		toolArgumentConstraints: {
			[input.authority.hostTenantArgument]: input.authority.hostOrganizationId,
		},
		toolNamespacePrefix: input.authority.hostTenantNamespace,
		toolAllowedCallables: input.authority.allowedCallables,
		embeddedSessionToken: input.embeddedSessionToken,
		platform,
	};
	runtime.bindTurn(binding);
	try {
		const execute = async (callable: string, args: Record<string, unknown>) => {
			const outcome = await runtime.executeTool(
				"tedix_mcp_call_tool",
				{
					callable,
					args: bindEmbeddedPortableTenantArgs(callable, args, input.authority),
				},
				{ signal: input.signal, binding },
			);
			return outcome && typeof outcome === "object" && "result" in outcome
				? (outcome as { result: unknown }).result
				: outcome;
		};
		return executeEmbeddedPortableCall({
			callable: input.callable,
			args: input.args,
			authority: input.authority,
			execute,
		});
	} finally {
		runtime.clearTurn();
	}
}

/** Direct browser calls bypass the model adapter's toolArgumentConstraints. */
export function bindEmbeddedPortableTenantArgs(
	callable: string,
	args: Record<string, unknown>,
	authority: {
		hostTenantNamespace: string;
		hostTenantArgument: string;
		hostOrganizationId: string;
	},
): Record<string, unknown> {
	if (!callable.startsWith(`${authority.hostTenantNamespace}.`)) return args;
	return {
		...args,
		[authority.hostTenantArgument]: authority.hostOrganizationId,
	};
}

export function embeddedPortableArgs(
	callable: string,
	args: Record<string, unknown>,
	authority: {
		hostOrganizationId: string;
		hostUserId: string;
		hostUserLabel?: string;
		hostRole?: string;
	},
): Record<string, unknown> {
	if (callable !== "work.add_comment") return args;
	if (
		!EMBEDDED_WORK_COMMENT_ROLES.has(
			String(authority.hostRole || "")
				.trim()
				.toLowerCase(),
		)
	) {
		throw new Error("Host role is not allowed to comment on embedded Work");
	}
	return {
		...args,
		metadata: {
			embeddedActor: {
				hostOrganizationId: authority.hostOrganizationId,
				hostUserId: authority.hostUserId,
				hostUserLabel: authority.hostUserLabel ?? null,
				hostRole: authority.hostRole ?? null,
			},
		},
	};
}

export function assertPortableCallable(
	callable: string,
	authority: {
		hostTenantNamespace: string;
		allowedCallables: readonly string[];
	},
): void {
	if (!authority.allowedCallables.includes(callable)) {
		throw new Error("Portable tool is not admitted for this session");
	}
}
