import {
	WorkAdmissionSpecificationReceiptSchema,
	WorkAdmissionSpecificationSchema,
	WorkResourcePoolProjectionSchema,
	WorkResourcePoolSchema,
} from "@tedix/api-contract/schemas/work-items";

interface BoardError {
	code?: string;
	status?: number;
	message: string;
}

type Call = (
	tool: string,
	input: Record<string, unknown>,
) => Promise<{ value: unknown; error?: BoardError }>;

/** Explicit namespace and literal paths: no cwd, glob expansion, or path aliases. */
export function fileResourceKeys(
	repoKey: string | undefined,
	paths: string[] | undefined,
): string[] {
	if (!repoKey || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(repoKey)) {
		throw new Error(
			"claim-files requires --repo-key with lowercase letters, digits, and single '.', '_' or '-' separators",
		);
	}
	if (!paths?.length)
		throw new Error("claim-files requires at least one --path");
	const keys = paths.map((path) => {
		if (
			!path ||
			path !== path.trim() ||
			/[\\:*?\[\]{}\x00-\x1f\x7f]/.test(path) ||
			path.startsWith("~") ||
			path.normalize("NFC") !== path ||
			path
				.split("/")
				.some(
					(segment) =>
						!segment ||
						segment === "." ||
						segment === ".." ||
						segment !== segment.trim(),
				)
		)
			throw new Error(
				`Invalid repository-relative file path: ${JSON.stringify(path)}`,
			);
		const key = `file:${repoKey}:${path}`;
		if (key.length > 300)
			throw new Error("File resource keys must not exceed 300 characters");
		return key;
	});
	const unique = [...new Set(keys)];
	if (unique.length > 100)
		throw new Error(
			"An admission specification supports at most 100 resources",
		);
	return unique;
}

export async function claimFiles(
	id: string,
	resourceKeys: string[],
	call: Call,
) {
	const createdResourceKeys: string[] = [];
	let pendingCreation: string | undefined;
	let replacementAttempted = false;
	let boardError: BoardError | undefined;
	const checkedCall = async (tool: string, input: Record<string, unknown>) => {
		const result = await call(tool, input);
		if (result.error) {
			boardError = result.error;
			throw new Error(result.error.message);
		}
		// Code Mode's withCompletionEvidence augments each native tool result.
		// Remove only that transport field after board errors have been checked;
		// admission business fields still go through the strict contract schema.
		if (
			typeof result.value === "object" &&
			result.value !== null &&
			!Array.isArray(result.value)
		) {
			const { completionEvidence: _completionEvidence, ...value } =
				result.value as Record<string, unknown>;
			return value;
		}
		return result.value;
	};
	try {
		const receipt = WorkAdmissionSpecificationReceiptSchema.parse(
			await checkedCall("work.get_work_admission_specification", { id }),
		);
		if (receipt.workItemId !== id)
			throw new Error("Admission receipt belongs to another Work Item");
		const existingKeys = new Set(
			receipt.resources.map((resource) => resource.resourceKey),
		);
		const addedResourceKeys = resourceKeys.filter(
			(key) => !existingKeys.has(key),
		);
		const specification = WorkAdmissionSpecificationSchema.parse({
			resources: [
				...receipt.resources,
				...addedResourceKeys.map((resourceKey) => ({
					resourceKey,
					quantity: 1,
				})),
			],
			budget: receipt.budget,
		});

		const pools = new Map<
			string,
			{ allocationMode: string; capacity: number }
		>();
		// Validate every exact lookup before creating any pool. Tenant inventory
		// size is unrelated to this request's already bounded resource keys.
		for (const resourceKey of resourceKeys) {
			const raw = await checkedCall("work.list_work_resource_pools", {
				resourceKey,
				limit: 1,
			});
			if (
				typeof raw !== "object" ||
				raw === null ||
				!("data" in raw) ||
				!("nextCursor" in raw) ||
				raw.nextCursor !== null
			)
				throw new Error("Incomplete or malformed exact resource pool lookup");
			const rows = WorkResourcePoolProjectionSchema.array()
				.max(1)
				.parse(raw.data);
			for (const { pool } of rows) {
				if (pool.resourceKey !== resourceKey)
					throw new Error(
						"Exact resource pool lookup returned a different resource key",
					);
				pools.set(resourceKey, pool);
			}
		}
		for (const key of resourceKeys) {
			const pool = pools.get(key);
			if (
				pool &&
				(pool.allocationMode !== "exclusive" || pool.capacity !== 1)
			) {
				throw new Error(
					`Resource pool ${key} is not exclusive with capacity 1; existing pools are never changed by claim-files`,
				);
			}
		}
		for (const resourceKey of resourceKeys) {
			if (pools.has(resourceKey)) continue;
			pendingCreation = resourceKey;
			const created = WorkResourcePoolSchema.parse(
				await checkedCall("work.put_work_resource_pool", {
					resourceKey,
					allocationMode: "exclusive",
					capacity: 1,
				}),
			);
			if (
				created.resourceKey !== resourceKey ||
				created.allocationMode !== "exclusive" ||
				created.capacity !== 1
			)
				throw new Error("Pool creation returned an unexpected resource pool");
			createdResourceKeys.push(resourceKey);
			pendingCreation = undefined;
		}
		let admission = receipt;
		// Pool repair may be needed, but unchanged requirements must not invalidate approvals.
		if (addedResourceKeys.length > 0) {
			replacementAttempted = true;
			admission = WorkAdmissionSpecificationReceiptSchema.parse(
				await checkedCall("work.replace_work_admission_specification", {
					id,
					expectedWorkItemVersion: receipt.workItemVersion,
					expectedAdmissionSpecRevision: receipt.admissionSpecRevision,
					specification,
				}),
			);
			if (admission.workItemId !== id)
				throw new Error("Admission replacement returned another Work Item");
			const returnedResources = new Map(
				admission.resources.map(({ resourceKey, quantity }) => [
					resourceKey,
					quantity,
				]),
			);
			if (
				returnedResources.size !== admission.resources.length ||
				returnedResources.size !== specification.resources.length ||
				specification.resources.some(
					({ resourceKey, quantity }) =>
						returnedResources.get(resourceKey) !== quantity,
				) ||
				admission.budget?.limitMicros !== specification.budget?.limitMicros ||
				admission.budget?.reservationMicros !==
					specification.budget?.reservationMicros
			) {
				throw new Error(
					"Admission replacement does not match the requested specification",
				);
			}
		}
		return {
			value: {
				workItemId: id,
				resourceKeys,
				addedResourceKeys,
				createdResourceKeys,
				changed: addedResourceKeys.length > 0 || createdResourceKeys.length > 0,
				reservation: "at_work_start",
				admission,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: {
				...boardError,
				message: `${message}. ${replacementAttempted ? "Admission replacement was not confirmed; re-read before retrying." : "Admission replacement was not attempted."}${pendingCreation ? ` Pool creation was not confirmed for ${pendingCreation}; re-read before retrying.` : ""}${createdResourceKeys.length ? ` Confirmed created pools remain: ${createdResourceKeys.join(", ")}.` : ""}`,
				createdResourceKeys,
				...(pendingCreation ? { unconfirmedPoolKey: pendingCreation } : {}),
				replacementAttempted,
			},
		};
	}
}
