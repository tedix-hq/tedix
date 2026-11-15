export type CmsProviderResourceState = "present" | "missing" | "unknown";

export interface CmsProviderResourceInspection {
	identifier: string;
	state: CmsProviderResourceState;
	error?: string;
}

export interface CmsProviderResources {
	durableObject: CmsProviderResourceInspection;
}

type CmsResourceEnv = Pick<CloudflareEnv, "CMS" | "PLATFORM_SERVICE_TOKEN">;

/** Provider readback remains separate from the CMS site row and fails open to unknown. */
export async function inspectCmsProviderResources(
	env: CmsResourceEnv,
	slug: string,
): Promise<CmsProviderResources> {
	const unknown = (
		identifier: string,
		error: string,
	): CmsProviderResourceInspection => ({
		identifier,
		state: "unknown",
		error,
	});
	try {
		const url = new URL(
			`https://cms.internal/api/internal/deployments/${encodeURIComponent(slug)}/resources`,
		);
		const response = await env.CMS.fetch(
			new Request(url, {
				headers: {
					Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
					"X-Tedix-Connection-Label": slug,
				},
			}),
		);
		const data = (await response.json()) as {
			success?: boolean;
			durableObject?: CmsProviderResourceInspection;
			error?: string;
		};
		if (!response.ok || !data.success) {
			const error =
				data.error ?? `CMS resource service returned ${response.status}`;
			return {
				durableObject: unknown(`EmDashDB:${slug}`, error),
			};
		}
		const valid = (
			resource: CmsProviderResourceInspection | undefined,
			identifier: string,
		) =>
			resource &&
			["present", "missing", "unknown"].includes(resource.state) &&
			resource.identifier === identifier
				? resource
				: unknown(
						identifier,
						"CMS resource service returned an invalid status",
					);
		return {
			durableObject: valid(data.durableObject, `EmDashDB:${slug}`),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			durableObject: unknown(`EmDashDB:${slug}`, message),
		};
	}
}

export interface CmsDeletedDataRecovery {
	restoredTo: string;
	storageState: "present" | "missing";
}

/** Ask the CMS runtime to rewind a deprovisioned site's emptied database. */
export async function recoverDeletedCmsData(
	env: CmsResourceEnv,
	slug: string,
): Promise<CmsDeletedDataRecovery> {
	const response = await env.CMS.fetch(
		new Request(
			`https://cms.internal/api/internal/deployments/${encodeURIComponent(slug)}/recover-deleted`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
					"X-Tedix-Connection-Label": slug,
				},
			},
		),
	);
	const data = (await response
		.json()
		.catch(() => ({}))) as Partial<CmsDeletedDataRecovery> & {
		ok?: boolean;
		error?: string;
	};
	if (
		!response.ok ||
		!data.ok ||
		!data.restoredTo ||
		(data.storageState !== "present" && data.storageState !== "missing")
	)
		throw new Error(data.error ?? `CMS runtime returned ${response.status}`);
	return { restoredTo: data.restoredTo, storageState: data.storageState };
}
