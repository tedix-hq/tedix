import { createHash } from "node:crypto";
import {
	HistoricalExposureSchema,
	HistoricalExposureInputSchema,
} from "@tedix/api-contract/schemas/billing";
import {
	getRetainedRuntimeRoot,
	type RetainedRuntimeRootRow,
} from "@tedix/db/queries/tedi-runtime-bootstrap";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";

export interface RetainedRootIdentity {
	tediId: string;
	orgId: string;
	objectId: string;
	objectName?: string;
	generation?: number;
	currentName?: string;
}
const refused = () => new Error("Retained root custody unavailable");
/** No caller-supplied name or leaf-only record qualifies a retained root. */
export function validateRetainedRootRow(
	row: RetainedRuntimeRootRow,
	identity: RetainedRootIdentity,
) {
	const value = HistoricalExposureSchema.parse(JSON.parse(row.payload));
	const request = HistoricalExposureInputSchema.parse({
		tediId: value.tediId,
		operationId: row.operationId,
		rootObjectId: value.rootObjectId,
		objectId: value.objectId,
		targetPath: value.targetPath,
		expectedGeneration: value.generation,
		snapshotId: value.snapshotId,
		sourceHash: value.sourceHash,
	});
	const hash = createHash("sha256")
		.update(
			JSON.stringify([
				value.organizationId,
				value.observedBy,
				value.observedUserId,
				request,
			]),
		)
		.digest("hex");
	if (
		value.tediId !== identity.tediId ||
		value.organizationId !== identity.orgId ||
		value.objectId !== identity.objectId ||
		value.rootObjectId !== value.objectId ||
		value.targetPath.length !== 0 ||
		value.className !== "AgentTediDO" ||
		value.objectName !== value.rootObjectName ||
		value.id !== row.id ||
		value.organizationId !== row.organizationId ||
		value.tediId !== row.tediId ||
		value.objectId !== row.objectId ||
		value.rootObjectName !== row.objectName ||
		value.generation !== row.generation ||
		value.snapshotId !== row.snapshotId ||
		value.sourceHash !== row.sourceHash ||
		value.exposure !== row.exposure ||
		value.observedBy !== row.observedBy ||
		value.observedUserId !== row.observedUserId ||
		value.observedAt !== row.observedAt ||
		value.requestHash !== row.requestHash ||
		hash !== row.requestHash ||
		row.currentOrganizationId !== identity.orgId ||
		typeof row.currentObjectName !== "string" ||
		!row.currentObjectName ||
		row.currentObjectName === row.objectName ||
		(identity.objectName !== undefined &&
			row.objectName !== identity.objectName) ||
		(identity.generation !== undefined &&
			row.generation !== identity.generation) ||
		(identity.currentName !== undefined &&
			row.currentObjectName !== identity.currentName)
	)
		throw refused();
	return value;
}
/** Read-only original provenance. This does not authorize execution or funding. */
export async function resolveRetainedRootCustody(
	db: Parameters<typeof getRetainedRuntimeRoot>[0],
	identity: RetainedRootIdentity,
) {
	const row = await getRetainedRuntimeRoot(db, identity);
	if (!row) throw refused();
	validateRetainedRootRow(row, identity);
	return row;
}
/** Final same-row D1 observation follows all imports/hash/provenance awaits.
 * On a leaf, the gated original root has already audited its archive; the private
 * registered relay carries ancestry, not independent provider attestation.
 */
export async function verifyRetainedRootCustody(
	env: Cloudflare.Env,
	identity: RetainedRootIdentity,
	recheck: () => void,
	storage?: DurableObjectStorage,
) {
	const row = await resolveRetainedRootCustody(env.DB, identity);
	recheck();
	if (
		env.TEDI_AGENT.idFromName(row.objectName).toString() !==
			identity.objectId ||
		env.TEDI_AGENT.idFromName(row.currentObjectName).toString() ===
			identity.objectId
	)
		throw refused();
	const audit = () => {
		if (!storage) return;
		const summary = new HistoricalLiabilityCustody(
			storage,
			identity.objectId,
		).audit();
		if (
			!summary ||
			summary.generation !== row.generation ||
			summary.snapshotId !== row.snapshotId ||
			summary.sourceHash !== row.sourceHash
		)
			throw refused();
	};
	audit();
	recheck();
	const final = await getRetainedRuntimeRoot(env.DB, identity);
	recheck();
	if (JSON.stringify(final) !== JSON.stringify(row)) throw refused();
	audit();
	recheck();
	return row;
}
