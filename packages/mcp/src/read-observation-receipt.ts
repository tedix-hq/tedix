export const READ_OBSERVATION_META_KEY = "io.tedix/readObservation";
export const READ_OBSERVATIONS_META_KEY = "io.tedix/readObservations";
export const READ_COLLECTION_META_KEY = "io.tedix/readCollection";
export const READ_COLLECTIONS_META_KEY = "io.tedix/readCollections";

export interface DocsFileObservationReceipt {
	version: 1;
	kind: "docs_file_observation";
	receiptId: string;
	provider: { appSlug: "docs"; toolName: "get_docs_file" };
	resource: { organizationSlug: string; siteId: string; path: string };
	evidence: {
		contentSha256: string;
		byteLength: number;
		observedGitRevision: string;
	};
	observedAt: string;
}

export interface OwnedReadObservation {
	innerCallId: string;
	receipt: DocsFileObservationReceipt;
}

/** Gateway-authored account of a successful connected-app read. A null
 * collection means the app tool has not declared one; it is not a guessed
 * collection or proof of which individual records the upstream returned. */
export interface ConnectedCollectionRead {
	version: 1;
	kind: "connected_collection_read";
	source: {
		appId: string;
		appSlug: string;
		toolName: string;
		connectionProviderId: string;
	};
	collection: string | null;
	observedAt: string;
}

export interface OwnedConnectedCollectionRead {
	innerCallId: string;
	observation: ConnectedCollectionRead;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\x20-\x7e]{1,2000}$/;
const COLLECTION_RE = /^[a-z][a-z0-9_.-]{0,119}$/;
const SOURCE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseDocsFileObservationReceipt(
	value: unknown,
): DocsFileObservationReceipt | null {
	const row = record(value);
	const provider = record(row?.provider);
	const resource = record(row?.resource);
	const evidence = record(row?.evidence);
	if (
		row?.version !== 1 ||
		row.kind !== "docs_file_observation" ||
		typeof row.receiptId !== "string" ||
		!UUID_RE.test(row.receiptId) ||
		provider?.appSlug !== "docs" ||
		provider.toolName !== "get_docs_file" ||
		typeof resource?.organizationSlug !== "string" ||
		!ORG_SLUG_RE.test(resource.organizationSlug) ||
		typeof resource.siteId !== "string" ||
		!UUID_RE.test(resource.siteId) ||
		typeof resource.path !== "string" ||
		!SAFE_PATH_RE.test(resource.path) ||
		typeof evidence?.contentSha256 !== "string" ||
		!SHA256_RE.test(evidence.contentSha256) ||
		typeof evidence.byteLength !== "number" ||
		!Number.isSafeInteger(evidence.byteLength) ||
		evidence.byteLength < 0 ||
		typeof evidence.observedGitRevision !== "string" ||
		!GIT_REVISION_RE.test(evidence.observedGitRevision) ||
		typeof row.observedAt !== "string" ||
		!Number.isFinite(Date.parse(row.observedAt))
	)
		return null;
	return {
		version: 1,
		kind: "docs_file_observation",
		receiptId: row.receiptId,
		provider: { appSlug: "docs", toolName: "get_docs_file" },
		resource: {
			organizationSlug: resource.organizationSlug,
			siteId: resource.siteId,
			path: resource.path,
		},
		evidence: {
			contentSha256: evidence.contentSha256,
			byteLength: evidence.byteLength,
			observedGitRevision: evidence.observedGitRevision,
		},
		observedAt: row.observedAt,
	};
}

export function parseOwnedReadObservations(
	value: unknown,
): OwnedReadObservation[] {
	if (!Array.isArray(value) || value.length > 100) return [];
	const parsed: OwnedReadObservation[] = [];
	for (const item of value) {
		const row = record(item);
		const receipt = parseDocsFileObservationReceipt(row?.receipt);
		if (
			typeof row?.innerCallId !== "string" ||
			row.innerCallId.length === 0 ||
			row.innerCallId.length > 200 ||
			!receipt
		) {
			return [];
		}
		parsed.push({ innerCallId: row.innerCallId, receipt });
	}
	return parsed;
}

export function parseConnectedCollectionRead(
	value: unknown,
): ConnectedCollectionRead | null {
	const row = record(value);
	const source = record(row?.source);
	if (
		row?.version !== 1 ||
		row.kind !== "connected_collection_read" ||
		typeof source?.appId !== "string" ||
		!APP_ID_RE.test(source.appId) ||
		typeof source.appSlug !== "string" ||
		!SOURCE_NAME_RE.test(source.appSlug) ||
		typeof source.toolName !== "string" ||
		!SOURCE_NAME_RE.test(source.toolName) ||
		typeof source.connectionProviderId !== "string" ||
		!SOURCE_NAME_RE.test(source.connectionProviderId) ||
		(row.collection !== null &&
			(typeof row.collection !== "string" ||
				!COLLECTION_RE.test(row.collection))) ||
		typeof row.observedAt !== "string" ||
		!Number.isFinite(Date.parse(row.observedAt))
	) {
		return null;
	}
	return {
		version: 1,
		kind: "connected_collection_read",
		source: {
			appId: source.appId,
			appSlug: source.appSlug,
			toolName: source.toolName,
			connectionProviderId: source.connectionProviderId,
		},
		collection: row.collection as string | null,
		observedAt: row.observedAt,
	};
}

export function parseOwnedConnectedCollectionReads(
	value: unknown,
): OwnedConnectedCollectionRead[] {
	if (!Array.isArray(value) || value.length > 100) return [];
	const parsed: OwnedConnectedCollectionRead[] = [];
	for (const item of value) {
		const row = record(item);
		const observation = parseConnectedCollectionRead(row?.observation);
		if (
			typeof row?.innerCallId !== "string" ||
			row.innerCallId.length === 0 ||
			row.innerCallId.length > 200 ||
			!observation
		) {
			return [];
		}
		parsed.push({ innerCallId: row.innerCallId, observation });
	}
	return parsed;
}
