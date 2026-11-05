import { resolveMcpToolRequiredScopes } from "@tedix/mcp-shared/auth/tool-scopes";
import type { DbClient } from "@tedix/db/client";
import { getAppsBySlugsWithTools } from "@tedix/db/queries/app-records";
import { getOrganizationAggregatorGateways } from "@tedix/db/queries/organization-members";
import { listOrganizations } from "@tedix/db/queries/organizations";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";

export interface GatewayToolContract {
	name: string;
	namespace: string;
	requiredScopes: string[];
	writeCapability: "read" | "write" | "destructive" | null;
	schemaHash: string | null;
}

export interface GatewayToolContractSnapshot {
	version: 1;
	organizationId: string;
	gatewayId: string;
	gatewaySlug: string;
	tools: GatewayToolContract[];
}

export interface GatewayToolContractDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

interface SnapshotBucket {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(
		key: string,
		value: string,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<unknown>;
}

interface AggregateAppEntry {
	slug: string;
	appId?: string;
	prefix?: string;
	toolIds?: string[];
	endpointPrefixes?: string[];
}

const SNAPSHOT_PREFIX = "gateway-tool-contracts/v1";

function callable(tool: GatewayToolContract): string {
	return `${tool.namespace}.${tool.name}`;
}

function stableSnapshot(snapshot: GatewayToolContractSnapshot): string {
	return JSON.stringify({
		...snapshot,
		tools: [...snapshot.tools].sort((left, right) =>
			callable(left) < callable(right)
				? -1
				: callable(left) > callable(right)
					? 1
					: 0,
		),
	});
}

export function diffGatewayToolContracts(
	previous: GatewayToolContractSnapshot | null,
	next: GatewayToolContractSnapshot,
): GatewayToolContractDiff {
	const before = new Map(
		(previous?.tools ?? []).map((tool) => [
			callable(tool),
			JSON.stringify(tool),
		]),
	);
	const after = new Map(
		next.tools.map((tool) => [callable(tool), JSON.stringify(tool)]),
	);
	const added = [...after.keys()].filter((name) => !before.has(name)).sort();
	const removed = [...before.keys()].filter((name) => !after.has(name)).sort();
	const changed = [...after.keys()]
		.filter((name) => before.has(name) && before.get(name) !== after.get(name))
		.sort();
	return { added, removed, changed };
}

async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function persistGatewayToolContractSnapshot(
	bucket: SnapshotBucket,
	snapshot: GatewayToolContractSnapshot,
	notify: (
		diff: GatewayToolContractDiff,
		snapshotHash: string,
	) => Promise<void>,
): Promise<GatewayToolContractDiff | null> {
	const key = `${SNAPSHOT_PREFIX}/${snapshot.organizationId}/${snapshot.gatewayId}.json`;
	const nextJson = stableSnapshot(snapshot);
	const stored = await bucket.get(key);
	const previousJson = stored ? await stored.text() : null;
	if (previousJson === nextJson) return null;

	let previous: GatewayToolContractSnapshot | null = null;
	if (previousJson) {
		previous = JSON.parse(previousJson) as GatewayToolContractSnapshot;
		if (previous.version !== 1 || !Array.isArray(previous.tools)) {
			throw new Error(`Invalid gateway tool contract snapshot at ${key}`);
		}
	}
	const diff = diffGatewayToolContracts(previous, snapshot);
	if (diff.added.length + diff.removed.length + diff.changed.length === 0)
		return null;
	const snapshotHash = await digest(nextJson);
	await notify(diff, snapshotHash);
	await bucket.put(key, nextJson, {
		httpMetadata: { contentType: "application/json" },
	});
	return diff;
}

function aggregateEntries(value: unknown): AggregateAppEntry[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is AggregateAppEntry =>
			Boolean(entry) &&
			typeof entry === "object" &&
			typeof (entry as { slug?: unknown }).slug === "string",
	);
}

function namespaceOf(entry: AggregateAppEntry): string {
	return (entry.prefix ?? entry.slug).replace(/[^a-zA-Z0-9_]/g, "_");
}

function gatewayRequiredScopes(
	...args: Parameters<typeof resolveMcpToolRequiredScopes>
): string[] | null {
	try {
		return resolveMcpToolRequiredScopes(...args).sort();
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("Missing MCP capability mapping for tool:")
		) {
			return null;
		}
		throw error;
	}
}

function formatNames(names: string[]): string {
	return names.length > 0
		? names.map((name) => `\`${name}\``).join(", ")
		: "none";
}

export async function snapshotOrganizationGatewayToolContracts(
	db: DbClient,
	bucket: SnapshotBucket,
	now = new Date().toISOString(),
): Promise<{ gatewaysChecked: number; gatewaysChanged: number }> {
	const organizations = [];
	for (let offset = 0; ; offset += 50) {
		const page = await listOrganizations(db, { limit: 50, offset });
		organizations.push(...page);
		if (page.length < 50) break;
	}
	const gateways = await getOrganizationAggregatorGateways(
		db,
		organizations.map((organization) => organization.id),
	);
	let gatewaysChecked = 0;
	let gatewaysChanged = 0;

	for (const [organizationId, selected] of gateways) {
		const [gatewaySurface] = await getAppsBySlugsWithTools(db, [
			{ slug: selected.slug, hostOrganizationId: organizationId },
		]);
		if (!gatewaySurface) continue;
		const gateway = gatewaySurface.app;
		const gatewayConfig = gateway.metadata?.mcpConfig;
		const entries = aggregateEntries(gatewayConfig?.aggregateApps);
		const sources = await getAppsBySlugsWithTools(
			db,
			entries.map((entry) => ({
				slug: entry.slug,
				appId: entry.appId,
				hostOrganizationId: organizationId,
				toolIds: entry.toolIds,
				endpointPrefixes: entry.endpointPrefixes,
			})),
		);
		const tools: GatewayToolContract[] = [];
		for (const [index, source] of sources.entries()) {
			const entry = entries[index];
			if (!entry || !source) continue;
			const namespace = namespaceOf(entry);
			const sourceConfig = source.app.metadata?.mcpConfig;
			const toolScopes = {
				...sourceConfig?.toolScopes,
				...gatewayConfig?.toolScopes,
			};
			for (const tool of source.tools) {
				const prefixed = {
					...tool,
					toolId: `${namespace}__${tool.toolId}`,
					authRequired: tool.authRequired ?? undefined,
					config: { ...tool.config, _aggregateNamespace: namespace },
				};
				const requiredScopes = gatewayRequiredScopes(prefixed, namespace, {
					...gatewayConfig,
					toolScopes,
				});
				// Connect fails closed on a tool with no capability mapping and never
				// lists it, so it is not part of the gateway's contract.
				if (!requiredScopes) continue;
				tools.push({
					name: tool.toolId,
					namespace,
					requiredScopes,
					writeCapability: tool.writeCapability,
					schemaHash: tool.contractHash ?? tool.schemaSourceHash,
				});
			}
		}

		gatewaysChecked++;
		const snapshot: GatewayToolContractSnapshot = {
			version: 1,
			organizationId,
			gatewayId: gateway.id,
			gatewaySlug: gateway.slug,
			tools,
		};
		const workItemId =
			typeof gatewayConfig?.contractChangeWorkItemId === "string"
				? gatewayConfig.contractChangeWorkItemId
				: null;
		const diff = await persistGatewayToolContractSnapshot(
			bucket,
			snapshot,
			async (change, snapshotHash) => {
				if (!workItemId) return;
				await addWorkItemCommentIfAbsent(db, {
					id: `gateway-contract:${gateway.id}:${snapshotHash}`,
					workItemId,
					orgId: organizationId,
					authorType: "system",
					authorId: "gateway-tool-contract-snapshot",
					body: `MCP gateway tool contract changed for \`${gateway.slug}\`.\n\nAdded: ${formatNames(change.added)}\nRemoved: ${formatNames(change.removed)}\nChanged: ${formatNames(change.changed)}`,
					metadata: {
						schema: "tedix.gateway-tool-contract-change.v1",
						gatewayId: gateway.id,
						snapshotHash,
						added: change.added,
						removed: change.removed,
						changed: change.changed,
					},
					createdAt: now,
					recordActivity: true,
				});
			},
		);
		if (diff) gatewaysChanged++;
	}

	return { gatewaysChecked, gatewaysChanged };
}
