/**
 * An in-memory organization log store for api tests, installed as the
 * workspace runtime the ledger service calls (`WORKSPACE_RUNTIME`). Like the
 * real store (`apps/workspace-do/src/organization-log.ts`) it keeps one chain
 * per organization, is live from the first append, and stores an id once.
 * Sealing is explicit (`seal`), with the same digest, chain hash and
 * checkpoint as the real store.
 */

import { env } from "cloudflare:workers";
import { onTestFinished } from "vite-plus/test";
import { sealRun } from "@tedix/agent-governance/seal";
import { GatewayChangeRecordSchema } from "@tedix/api-contract/schemas/audit";
import type {
	GatewayChangeRecordCheckpointRow,
	OrganizationLogRecord,
	OrganizationLogRuntime,
} from "@tedix/db/queries/durable-sqlite/organization-log-rpc";

interface Chain {
	records: OrganizationLogRecord[];
	checkpoints: GatewayChangeRecordCheckpointRow[];
	next: number;
}

export function createOrganizationLogFixture() {
	const chains = new Map<string, Chain>();
	const chain = (organizationId: string) => {
		let found = chains.get(organizationId);
		if (!found) {
			found = { records: [], checkpoints: [], next: 1 };
			chains.set(organizationId, found);
		}
		return found;
	};
	// Copies, as an RPC answer is: a caller can never edit the stored record.
	const live = <T>(value: T) => ({
		status: "live" as const,
		value: structuredClone(value),
	});

	const runtime: OrganizationLogRuntime = {
		organizationLogAvailable: async () => true,
		async organizationLogAppend(organizationId, input) {
			const log = chain(organizationId);
			const stored = log.records.find((record) => record.id === input.id);
			if (stored) return { status: "stored", record: structuredClone(stored) };
			const record = {
				...structuredClone(input),
				sequence: log.next++,
				recordDigest: null,
				chainHash: null,
			};
			log.records.push(record);
			return { status: "stored", record: structuredClone(record) };
		},
		async organizationLogList(organizationId, query) {
			return live(
				chain(organizationId)
					.records.filter(
						(record) =>
							(query.resource === undefined ||
								record.resource === query.resource) &&
							(query.actorId === undefined ||
								(record.actor as { id: string }).id === query.actorId) &&
							(query.afterSequence === undefined ||
								record.sequence > query.afterSequence),
					)
					.slice(0, query.limit),
			);
		},
		async organizationLogGet(organizationId, id) {
			return live(
				chain(organizationId).records.find((record) => record.id === id) ??
					null,
			);
		},
		async organizationLogRange(organizationId, range, page) {
			const matching = chain(organizationId).records.filter(
				(record) =>
					record.recordedAt >= range.from &&
					record.recordedAt < range.until &&
					(range.resource === undefined ||
						record.resource === range.resource) &&
					(range.actorId === undefined ||
						(record.actor as { id: string }).id === range.actorId) &&
					(range.subjectId === undefined ||
						(record.subject as { id?: string } | undefined)?.id ===
							range.subjectId),
			);
			return live({
				count: matching.length,
				records: matching
					.filter(
						(record) =>
							page.afterSequence === undefined ||
							record.sequence > page.afterSequence,
					)
					.slice(0, page.limit),
			});
		},
		async organizationLogCheckpoints(organizationId, query) {
			return live(
				chain(organizationId)
					.checkpoints.filter(
						(c) =>
							(query.fromSequence === undefined ||
								c.lastSequence >= query.fromSequence) &&
							(query.untilSequence === undefined ||
								c.firstSequence <= query.untilSequence) &&
							(query.sealedFrom === undefined ||
								c.sealedAt >= query.sealedFrom) &&
							(query.sealedUntil === undefined ||
								c.sealedAt < query.sealedUntil) &&
							(query.afterLastSequence === undefined ||
								c.lastSequence > query.afterLastSequence),
					)
					.slice(0, query.limit),
			);
		},
		async organizationLogStatus() {
			return {
				available: true,
				state: "live",
				tail: null,
				pending: 0,
				oldestPendingAt: null,
				cutoverStartedAt: null,
				mainTailSequence: null,
			};
		},
	};

	return {
		runtime,
		/** The organization's stored records, by reference: edit to tamper. */
		records: (organizationId: string) => chain(organizationId).records,
		/** Chain and checkpoint every record after the last checkpoint. */
		async seal(
			organizationId: string,
			sealedAt: string,
			signer?: { privateKey: CryptoKey; keyId: string },
		) {
			const log = chain(organizationId);
			const last = log.checkpoints.at(-1) ?? null;
			const open = log.records.filter(
				(record) => record.sequence > (last?.lastSequence ?? 0),
			);
			if (open.length === 0) return;
			const { seals, checkpoint } = await sealRun({
				organizationId,
				records: open.map(
					({ recordDigest: _d, chainHash: _c, ...record }) =>
						GatewayChangeRecordSchema.parse(record) as never,
				),
				previousChainHash: last?.headChainHash ?? null,
				previousCheckpointDigest: last?.checkpointDigest ?? null,
				sealedAt,
				signer,
			});
			open.forEach((record, index) => {
				record.recordDigest = seals[index]!.recordDigest;
				record.chainHash = seals[index]!.chainHash;
			});
			log.checkpoints.push({
				id: crypto.randomUUID(),
				organizationId,
				firstSequence: checkpoint.firstSequence,
				lastSequence: checkpoint.lastSequence,
				recordCount: checkpoint.recordCount,
				headChainHash: checkpoint.headChainHash,
				previousCheckpointDigest: checkpoint.previousCheckpointDigest,
				previousChainHash: checkpoint.previousChainHash,
				checkpointDigest: checkpoint.digest,
				sealedAt,
				envelope: checkpoint.envelope
					? JSON.stringify(checkpoint.envelope)
					: null,
				keyId: signer?.keyId ?? null,
				evidenceBundleKey: null,
			});
		},
	};
}

/** Install a fresh fixture for this test; it is removed when the test ends. */
export function installOrganizationLogFixture() {
	const fixture = createOrganizationLogFixture();
	Object.assign(env, { WORKSPACE_RUNTIME: fixture.runtime });
	onTestFinished(() => {
		Reflect.deleteProperty(env, "WORKSPACE_RUNTIME");
	});
	return fixture;
}
