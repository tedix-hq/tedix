export type CmsMediaResourceState = "ready" | "missing" | "unknown";

export interface CmsMediaResourceInspection {
	bucketName: string;
	state: CmsMediaResourceState;
	error?: string;
}

export interface CmsMediaResourceRepair {
	bucketName: string;
	created: boolean;
}

export type CmsMediaRepairIntent = "create" | "repair";

type CmsResourceEnv = Pick<CloudflareEnv, "CMS" | "PLATFORM_SERVICE_TOKEN">;

function request(
	env: CmsResourceEnv,
	slug: string,
	method: "GET" | "POST",
	intent?: CmsMediaRepairIntent,
	siteId?: string,
) {
	return env.CMS.fetch(
		new Request(
			`https://cms.internal/api/internal/deployments/${encodeURIComponent(slug)}/media`,
			{
				method,
				headers: {
					Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
					"X-Tedix-Connection-Label": slug,
					...(intent ? { "X-Tedix-CMS-Media-Intent": intent } : {}),
					...(siteId ? { "X-Tedix-CMS-Site-Id": siteId } : {}),
				},
			},
		),
	);
}

export async function inspectCmsMediaResource(
	env: CmsResourceEnv,
	slug: string,
): Promise<CmsMediaResourceInspection> {
	try {
		const response = await request(env, slug, "GET");
		const data = (await response.json()) as {
			success?: boolean;
			bucketName?: string;
			exists?: boolean;
			error?: string;
		};
		if (!response.ok || !data.success || !data.bucketName) {
			return {
				bucketName: `tedix-cms-media-${slug}`,
				state: "unknown",
				error: data.error ?? `CMS resource service returned ${response.status}`,
			};
		}
		return {
			bucketName: data.bucketName,
			state: data.exists ? "ready" : "missing",
		};
	} catch (error) {
		return {
			bucketName: `tedix-cms-media-${slug}`,
			state: "unknown",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function repairCmsMediaResource(
	env: CmsResourceEnv,
	slug: string,
	intent: CmsMediaRepairIntent,
	siteId: string,
): Promise<CmsMediaResourceRepair> {
	const response = await request(env, slug, "POST", intent, siteId);
	const data = (await response.json()) as {
		success?: boolean;
		bucketName?: string;
		created?: boolean;
		error?: string;
	};
	if (!response.ok || !data.success || !data.bucketName) {
		throw new Error(
			data.error ?? `CMS resource service returned ${response.status}`,
		);
	}
	return { bucketName: data.bucketName, created: data.created === true };
}
