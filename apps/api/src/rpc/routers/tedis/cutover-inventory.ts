import { requireCustodyInspectionScope } from "../../context";
/** Temporary finite raw-object inventory, removed after persisted-state cutover. */
import {
	TediRuntimeCutoverInventoryResponseSchema,
	TediRuntimeCutoverOperationResponseSchema,
	type TediRuntimeCutoverOperationQuery,
	type TediRuntimeCutoverOperationResponse,
	type TediRuntimeCutoverInventoryResponse,
} from "@tedix/api-contract/schemas/tedi";
import { agentAdminFetch, assertPlatformAdminOrServiceBinding } from "./crud";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	requireTediAccess,
} from "./helpers";

// Diagnostic paths use only schema-owned keys. Zod messages and unknown keys
// may contain private values and must never cross this boundary.
const diagnosticFields = new Set([
	"ok",
	"id",
	"sampledAt",
	"inventory",
	"storedOwner",
	"tediId",
	"orgId",
	"slug",
	"sessionKey",
	"unknown",
	"tables",
	"name",
	"rows",
	"imported",
	"activeConversationId",
	"receipts",
	"source",
	"status",
	"terminal",
	"sha256",
	"privateImages",
	"key",
	"scheme",
	"children",
	"className",
	"identityVersion",
	"identityName",
	"maintenance",
	"taskId",
	"scheduleId",
	"nextRunAt",
	"blocked",
	"hash",
	"offset",
	"limit",
	"counts",
	"nextOffset",
]);
function inventoryValidationSummary(
	issues: readonly { path: readonly PropertyKey[]; code: string }[],
	payload: unknown,
): string {
	return issues
		.slice(0, 5)
		.map((issue) => {
			let value = payload;
			const path = issue.path
				.slice(0, 8)
				.map((part) => {
					if (
						typeof part === "number" &&
						Number.isSafeInteger(part) &&
						part >= 0
					) {
						value = Array.isArray(value) ? value[part] : undefined;
						return `[${part}]`;
					}
					if (typeof part === "string" && diagnosticFields.has(part)) {
						value =
							value !== null &&
							typeof value === "object" &&
							Object.hasOwn(value, part)
								? (value as Record<string, unknown>)[part]
								: undefined;
						return part;
					}
					value = undefined;
					return "?";
				})
				.join(".");
			const length =
				typeof value === "string" || Array.isArray(value)
					? ` length=${value.length}`
					: "";
			return `${path || "$"}:${issue.code}${length}`;
		})
		.join("; ")
		.slice(0, 900);
}

// Closed runtime inspection refusals only. Unknown payloads and exception text
// remain private; a syntactically plausible label is not a trusted diagnostic.
const inspectionRefusals = new Set([
	"inspection_metadata_changed",
	"admission_epoch_changed",
	"inspection_owner_mismatch",
	"inspection_owner_unavailable",
	"canonical_custody_mismatch",
	"passive_inspection_unavailable",
	"verification_rejected",
]);
function transportFailureHint(result: {
	error: string;
	failure: unknown;
}): string {
	try {
		const field = Object.getOwnPropertyDescriptor(result, "failure");
		if (
			field &&
			"value" in field &&
			[
				"no_provisioning_config",
				"service_binding_unavailable",
				"secrets_master_key_unavailable",
				"timeout",
				"transport_failure",
			].includes(field.value)
		)
			return ` (transport ${field.value})`;
	} catch {
		/* Never expose hostile exception text. */
	}
	return "";
}
function inspectionRefusalHint(result: {
	status: number;
	json: unknown;
}): string {
	let statusHint = "";
	try {
		const descriptor = Object.getOwnPropertyDescriptor(result, "status");
		if (!descriptor || !("value" in descriptor)) return "";
		const status: unknown = descriptor.value;
		if (
			typeof status !== "number" ||
			!Number.isSafeInteger(status) ||
			status < 100 ||
			status > 599
		)
			return "";
		statusHint = ` (runtime status ${status})`;
		const body = result.json;
		if (!body || typeof body !== "object" || Array.isArray(body))
			return statusHint;
		const fields = Reflect.ownKeys(body);
		if (
			fields.length !== 2 ||
			!fields.includes("ok") ||
			!fields.includes("rejection")
		)
			return statusHint;
		const ok = Object.getOwnPropertyDescriptor(body, "ok"),
			rejection = Object.getOwnPropertyDescriptor(body, "rejection");
		if (
			!ok ||
			!("value" in ok) ||
			ok.value !== false ||
			!rejection ||
			!("value" in rejection) ||
			typeof rejection.value !== "string" ||
			!inspectionRefusals.has(rejection.value)
		)
			return statusHint;
		return ` (runtime status ${status}; rejection ${rejection.value})`;
	} catch {
		return statusHint;
	}
}

export function cutoverInventoryFromAdminFetch(
	result: Awaited<ReturnType<typeof agentAdminFetch>>,
	objectId: string,
	page: {
		offset: number;
		limit: number;
		expectedHash?: string;
		expectedInspectionHash?: string;
		expectedGeneration?: number;
	} = {
		offset: 0,
		limit: 200,
	},
): TediRuntimeCutoverInventoryResponse {
	if ("error" in result || !result.ok)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`Runtime cutover inventory unavailable${"error" in result ? transportFailureHint(result) : inspectionRefusalHint(result)}`,
		);
	const parsed = TediRuntimeCutoverInventoryResponseSchema.safeParse(
		result.json,
	);
	if (!parsed.success)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`Runtime cutover inventory returned an unexpected payload: ${inventoryValidationSummary(parsed.error.issues, result.json)}`,
		);
	if (
		parsed.data.id !== objectId ||
		parsed.data.offset !== page.offset ||
		parsed.data.limit !== page.limit ||
		(page.expectedHash !== undefined &&
			parsed.data.hash !== page.expectedHash) ||
		(page.expectedInspectionHash !== undefined &&
			parsed.data.inspectionHash !== page.expectedInspectionHash) ||
		(page.expectedGeneration !== undefined &&
			(parsed.data.admission?.generation ?? 0) !== page.expectedGeneration)
	)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime cutover inventory returned an unexpected payload",
		);
	return parsed.data;
}

export const inspectRuntimeCutoverProcedure =
	authedTedisOs.inspectRuntimeCutover
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			assertPlatformAdminOrServiceBinding(context);
			// This tedi supplies access and routing only. Ownership is stored metadata.
			const routeTedi = await requireTediAccess(context, input.routeTediId);
			return cutoverInventoryFromAdminFetch(
				await agentAdminFetch(context, routeTedi, "/__admin/pi-state-cutover", {
					method: "GET",
					query: {
						objectId: input.objectId,
						offset: String(input.offset),
						limit: String(input.limit),
						expectedHash: input.expectedHash,
						expectedInspectionHash: input.expectedInspectionHash,
						custodyTediId: input.custodyTediId,
						targetPath: input.targetPath
							? JSON.stringify(input.targetPath)
							: undefined,
						expectedGeneration:
							input.expectedGeneration === undefined
								? undefined
								: String(input.expectedGeneration),
						candidateObjectNames:
							input.candidateObjectNames === undefined
								? undefined
								: JSON.stringify(input.candidateObjectNames),
					},
					requireServiceBinding: true,
					timeoutMs: 10_000,
				}),
				input.targetPath?.at(-1)?.objectId ?? input.objectId,
				input,
			);
		});

export function cutoverOperationFromAdminFetch(
	result: { ok: boolean; status: number; json: unknown } | { error: string },
	input: TediRuntimeCutoverOperationQuery,
): TediRuntimeCutoverOperationResponse {
	// Reset has no successful receipt. Even a forged 200 cannot certify adoption.
	if (input.command === "exclude_writers")
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime writer exclusion outcome UNKNOWN. Before retry, perform fresh authenticated inspection of the same current owner custody, physical object and nonactive generation and actual Raw receiver raw-cutover-v1. If verified, stop retrying; absent or changed proof leaves outcome UNKNOWN. Never retry automatically.",
		);

	if (
		(input.command === "inspect_historical_custody" ||
			input.command === "capture_historical_custody" ||
			input.command === "audit_historical_custody") &&
		("error" in result || !result.ok)
	)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime historical custody unavailable",
		);
	if (
		input.command === "inspect_capture_size" &&
		("error" in result || !result.ok)
	)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime capture size diagnostic unavailable",
		);
	if (
		input.command === "quarantine" &&
		input.targetPath &&
		("error" in result || !result.ok)
	)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime registered quarantine unavailable",
		);

	if ("error" in result || !result.ok) {
		const rejection =
			!("error" in result) && result.json && typeof result.json === "object"
				? (result.json as Record<string, unknown>).rejection
				: undefined;
		const code =
			typeof rejection === "string" && /^[a-z_]{1,64}$/.test(rejection)
				? `; rejection ${rejection}`
				: "";
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			`Runtime cutover operation unavailable${"error" in result ? " (transport failure)" : ` (runtime status ${result.status}${code})`}`,
		);
	}
	const parsed = TediRuntimeCutoverOperationResponseSchema.safeParse(
		result.json,
	);
	if (!parsed.success)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime cutover operation returned an unexpected payload",
		);
	const value = parsed.data;
	if (
		input.command === "inspect_custody_coverage" ||
		value.command === "inspect_custody_coverage"
	) {
		if (
			input.command !== "inspect_custody_coverage" ||
			value.command !== input.command ||
			value.id !== input.objectId ||
			value.targetObjectId !==
				(input.targetPath?.at(-1)?.objectId ?? input.objectId) ||
			value.operationId !== input.operationId ||
			value.generation !== input.expectedGeneration ||
			(input.coverageHash !== undefined &&
				value.coverageHash !== input.coverageHash)
		)
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Runtime custody metadata returned an unexpected payload",
			);
		return value;
	}

	if (
		input.command === "inspect_native_preservation" ||
		input.command === "capture_native_preservation" ||
		input.command === "audit_native_preservation" ||
		input.command === "inspect_sdk_preservation" ||
		input.command === "capture_sdk_preservation" ||
		input.command === "audit_sdk_preservation" ||
		input.command === "inspect_session_preservation" ||
		input.command === "capture_session_preservation" ||
		input.command === "audit_session_preservation" ||
		input.command === "inspect_session_rehydration"
	) {
		if (
			!("archive" in value) ||
			value.command !== input.command ||
			value.id !== input.objectId ||
			value.targetObjectId !==
				(input.targetPath?.at(-1)?.objectId ?? input.objectId) ||
			value.operationId !== input.operationId ||
			value.generation !== input.expectedGeneration ||
			("archiveId" in input &&
				value.archive !== null &&
				value.archive.archiveId !== input.archiveId) ||
			((input.command === "capture_native_preservation" ||
				input.command === "capture_session_preservation" ||
				input.command === "capture_sdk_preservation") &&
				value.archive === null)
		)
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Runtime native preservation returned an unexpected payload",
			);
		return value;
	}
	if ("archive" in value)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime native preservation returned an unexpected payload",
		);
	if (
		input.command === "inspect_historical_custody" ||
		input.command === "capture_historical_custody" ||
		input.command === "audit_historical_custody"
	) {
		if (
			value.command !== input.command ||
			value.id !== input.objectId ||
			value.targetObjectId !== input.targetPath?.at(-1)?.objectId ||
			value.operationId !== input.operationId ||
			value.generation !== input.expectedGeneration ||
			(input.command !== "inspect_historical_custody" &&
				(!("sourceHash" in value) ||
					value.sourceHash !== input.expectedSourceHash))
		)
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Runtime historical custody returned an unexpected payload",
			);
		return value;
	}
	if ("snapshotId" in value)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime cutover operation returned an unexpected payload",
		);
	if (input.command === "inspect_capture_size") {
		if (
			value.command !== "inspect_capture_size" ||
			value.id !== input.objectId ||
			value.operationId !== input.operationId ||
			value.generation !== input.expectedGeneration
		)
			throw createError(
				ErrorCodes.BAD_GATEWAY,
				"Runtime capture size returned an unexpected payload",
			);
		return value;
	}
	if (value.command === "inspect_capture_size")
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime cutover operation returned an unexpected payload",
		);
	const command = input.command;
	const generation =
		command === "bootstrap_prepare"
			? 2
			: command === "prepare" ||
				  command === "release" ||
				  command === "quarantine"
				? input.expectedGeneration + 1
				: input.expectedGeneration;
	const requiredState =
		command === "prepare" ||
		command === "bootstrap_prepare" ||
		command === "apply" ||
		command === "transfer_accounting"
			? "held"
			: command === "release"
				? "active"
				: command === "quarantine"
					? "quarantined"
					: undefined;
	if (
		(command !== "plan" &&
			command !== "inspect_accounting" &&
			command !== "quarantine" &&
			((value.unknown ?? 0) !== 0 || (value.nonterminal ?? 0) !== 0)) ||
		value.id !== input.objectId ||
		value.targetObjectId !==
			(input.targetPath?.at(-1)?.objectId ?? input.target?.objectId) ||
		value.command !== command ||
		value.operationId !== input.operationId ||
		value.generation !== generation ||
		(requiredState !== undefined && value.state !== requiredState) ||
		("sourceHash" in input && value.sourceHash !== input.sourceHash) ||
		(command === "plan" &&
			(value.sourceHash === undefined || value.evidenceHash === undefined)) ||
		((command === "inspect_accounting" || command === "transfer_accounting") &&
			(value.accountingManifestHash === undefined ||
				value.records === undefined)) ||
		(command === "transfer_accounting" &&
			(value.accountingManifestHash !== input.accountingManifestHash ||
				value.sourceHashBefore === undefined ||
				value.sourceHashAfter === undefined ||
				value.destinationHashBefore === undefined ||
				value.destinationHashAfter === undefined))
	)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"Runtime cutover operation returned an unexpected payload",
		);
	return value;
}
/** Server-derived immutable root name for historical commands only. No mutation fallback. */
export async function retainedHistoricalCustodyName(
	db: Parameters<
		typeof import("@tedix/db/queries/tedi-runtime-bootstrap").getRetainedRuntimeRoot
	>[0],
	input: {
		tediId: string;
		orgId: string;
		objectId: string;
		currentName: string;
	},
) {
	try {
		const { getRetainedRuntimeRoot } =
			await import("@tedix/db/queries/tedi-runtime-bootstrap");
		const row = await getRetainedRuntimeRoot(db, {
			tediId: input.tediId,
			orgId: input.orgId,
			objectId: input.objectId,
		});
		if (!row) return input.currentName;
		const { HistoricalExposureSchema, HistoricalExposureInputSchema } =
			await import("@tedix/api-contract/schemas/billing");
		const { sha256Hex } = await import("@tedix/worker-kit/crypto");
		const v = HistoricalExposureSchema.parse(JSON.parse(row.payload));
		const request = HistoricalExposureInputSchema.parse({
			tediId: v.tediId,
			operationId: row.operationId,
			rootObjectId: v.rootObjectId,
			objectId: v.objectId,
			targetPath: v.targetPath,
			expectedGeneration: v.generation,
			snapshotId: v.snapshotId,
			sourceHash: v.sourceHash,
		});
		const hash = await sha256Hex(
			JSON.stringify([
				v.organizationId,
				v.observedBy,
				v.observedUserId,
				request,
			]),
		);
		if (
			v.id !== row.id ||
			row.tediId !== v.tediId ||
			row.organizationId !== v.organizationId ||
			row.objectId !== v.objectId ||
			v.tediId !== input.tediId ||
			v.organizationId !== input.orgId ||
			v.objectId !== input.objectId ||
			v.rootObjectId !== v.objectId ||
			v.className !== "AgentTediDO" ||
			v.targetPath.length ||
			v.objectName !== v.rootObjectName ||
			v.rootObjectName !== row.objectName ||
			v.generation !== row.generation ||
			v.snapshotId !== row.snapshotId ||
			v.sourceHash !== row.sourceHash ||
			v.requestHash !== row.requestHash ||
			hash !== row.requestHash ||
			v.observedBy !== row.observedBy ||
			v.observedUserId !== row.observedUserId ||
			v.observedAt !== row.observedAt ||
			row.exposure !== "UNKNOWN" ||
			row.currentOrganizationId !== input.orgId ||
			row.currentObjectName !== input.currentName
		)
			throw new Error();
		const final = await getRetainedRuntimeRoot(db, {
			tediId: input.tediId,
			orgId: input.orgId,
			objectId: input.objectId,
		});
		if (JSON.stringify(final) !== JSON.stringify(row)) throw new Error();
		return v.rootObjectName;
	} catch {
		throw createError(
			ErrorCodes.CONFLICT,
			"Runtime historical custody unavailable",
		);
	}
}
export const operateRuntimeCutoverProcedure =
	authedTedisOs.operateRuntimeCutover
		.use(AUTHZ.platformAdmin)
		.handler(async ({ input, context }) => {
			assertPlatformAdminOrServiceBinding(context);
			const scope =
				input.command === "inspect_custody_coverage"
					? requireCustodyInspectionScope(context)
					: null;
			const checked = <T>(read: () => PromiseLike<T>) =>
				scope ? scope.checked(read) : Promise.resolve(read());
			const routeTedi = await checked(() =>
				requireTediAccess(context, input.routeTediId),
			);
			const custodyTedi =
				"custodyTediId" in input && input.custodyTediId !== undefined
					? await checked(() =>
							requireTediAccess(context, input.custodyTediId!),
						)
					: null;
			if (
				custodyTedi &&
				(typeof custodyTedi.isolateAgentId !== "string" ||
					custodyTedi.isolateAgentId.length < 1 ||
					custodyTedi.isolateAgentId.length > 1024 ||
					!custodyTedi.organizationId)
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Canonical cutover custody unavailable",
				);
			const custodyName =
				custodyTedi &&
				(input.command === "inspect_native_preservation" ||
					input.command === "capture_native_preservation" ||
					input.command === "audit_native_preservation" ||
					input.command === "inspect_sdk_preservation" ||
					input.command === "capture_sdk_preservation" ||
					input.command === "audit_sdk_preservation" ||
					input.command === "inspect_session_preservation" ||
					input.command === "capture_session_preservation" ||
					input.command === "audit_session_preservation" ||
					input.command === "inspect_session_rehydration" ||
					input.command === "inspect_custody_coverage" ||
					input.command === "inspect_historical_custody" ||
					input.command === "capture_historical_custody" ||
					input.command === "audit_historical_custody")
					? await checked(() =>
							retainedHistoricalCustodyName(context.env.DB, {
								tediId: custodyTedi.id,
								orgId: custodyTedi.organizationId!,
								objectId: input.objectId,
								currentName: custodyTedi.isolateAgentId!,
							}),
						)
					: custodyTedi?.isolateAgentId;
			const {
				routeTediId: _route,
				custodyTediId: _custody,
				...operation
			} = input as TediRuntimeCutoverOperationQuery & {
				custodyTediId?: string;
			};
			const result = await checked(() =>
				agentAdminFetch(context, routeTedi, "/__admin/pi-state-cutover", {
					method: "POST",
					requireServiceBinding: true,
					timeoutMs: 30_000,
					custodyInspectionScope: scope ?? undefined,
					body: {
						...operation,
						custody: custodyTedi
							? {
									tediId: custodyTedi.id,
									orgId: custodyTedi.organizationId,
									objectName: custodyName,
								}
							: null,
					},
				}),
			);
			scope?.guard();
			const value = cutoverOperationFromAdminFetch(result, input);
			scope?.guard();
			return value;
		});
