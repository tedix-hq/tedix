type CmsRecoveryEnv = Pick<CloudflareEnv, "CMS" | "PLATFORM_SERVICE_TOKEN">;

export interface CmsRecoveryStatus {
	siteId: string;
	captureId: string;
	status: string;
	capturedAt?: string;
	retainUntil?: string;
	bundle?: { version: number; etag: string };
	media?: { count: number; bytes: number };
}

async function callRecovery(
	env: CmsRecoveryEnv,
	args: {
		slug: string;
		siteId: string;
		captureId?: string;
		method: "GET" | "POST" | "DELETE";
	},
): Promise<CmsRecoveryStatus> {
	const url = new URL(
		`https://cms.internal/api/internal/deployments/${encodeURIComponent(args.slug)}/recovery-captures`,
	);
	url.searchParams.set("siteId", args.siteId);
	if (args.captureId) url.searchParams.set("captureId", args.captureId);
	const response = await env.CMS.fetch(
		new Request(url, {
			method: args.method,
			headers: {
				Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
				"X-Tedix-Connection-Label": args.slug,
			},
		}),
	);
	const data = (await response.json()) as Partial<CmsRecoveryStatus> & {
		ok?: boolean;
		error?: string;
	};
	if (
		!response.ok ||
		data.ok !== true ||
		data.siteId !== args.siteId ||
		!data.captureId ||
		typeof data.status !== "string"
	)
		throw new Error(
			data.error ?? `CMS recovery service returned ${response.status}`,
		);
	return {
		siteId: data.siteId,
		captureId: data.captureId,
		status: data.status,
		...(data.capturedAt ? { capturedAt: data.capturedAt } : {}),
		...(data.retainUntil ? { retainUntil: data.retainUntil } : {}),
		...(data.bundle ? { bundle: data.bundle } : {}),
		...(data.media ? { media: data.media } : {}),
	};
}

export async function startCmsRecoveryCapture(
	env: CmsRecoveryEnv,
	slug: string,
	siteId: string,
): Promise<CmsRecoveryStatus> {
	return callRecovery(env, { slug, siteId, method: "POST" });
}

export async function getCmsRecoveryCapture(
	env: CmsRecoveryEnv,
	slug: string,
	siteId: string,
	captureId: string,
): Promise<CmsRecoveryStatus> {
	return callRecovery(env, { slug, siteId, captureId, method: "GET" });
}

export async function purgeCmsRecoveryCapture(
	env: CmsRecoveryEnv,
	slug: string,
	siteId: string,
	captureId: string,
): Promise<CmsRecoveryStatus> {
	return callRecovery(env, { slug, siteId, captureId, method: "DELETE" });
}

export async function inspectLatestCmsRecoveryCapture(
	env: CmsRecoveryEnv,
	slug: string,
	siteId: string,
): Promise<{ verified: boolean; captureId?: string }> {
	try {
		const url = new URL(
			`https://cms.internal/api/internal/deployments/${encodeURIComponent(slug)}/recovery-captures`,
		);
		url.searchParams.set("siteId", siteId);
		const response = await env.CMS.fetch(
			new Request(url, {
				headers: {
					Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
					"X-Tedix-Connection-Label": slug,
				},
			}),
		);
		if (!response.ok) return { verified: false };
		const data = (await response.json()) as {
			ok?: boolean;
			siteId?: string;
			status?: string;
			captureId?: string;
		};
		return data.ok === true &&
			data.siteId === siteId &&
			data.status === "verified" &&
			data.captureId
			? { verified: true, captureId: data.captureId }
			: { verified: false };
	} catch {
		return { verified: false };
	}
}

export interface CmsSiteRestoreStatus {
	siteId: string;
	captureId: string;
	generation: string;
	phase:
		| "claimed"
		| "fenced"
		| "drained"
		| "undo-captured"
		| "target-schedule-intent"
		| "target-scheduled"
		| "target-sql-verified"
		| "target-media-verified"
		| "undo-schedule-intent"
		| "undo-scheduled"
		| "undo-sql-verified"
		| "undo-media-verified"
		| "release-intent"
		| "released"
		| "held";
	createdAt: string;
	updatedAt: string;
	errorCode?: string;
}

const RESTORE_PHASES = new Set<CmsSiteRestoreStatus["phase"]>([
	"claimed",
	"fenced",
	"drained",
	"undo-captured",
	"target-schedule-intent",
	"target-scheduled",
	"target-sql-verified",
	"target-media-verified",
	"undo-schedule-intent",
	"undo-scheduled",
	"undo-sql-verified",
	"undo-media-verified",
	"release-intent",
	"released",
	"held",
]);

async function callSiteRestore(
	env: CmsRecoveryEnv,
	args: {
		slug: string;
		siteId: string;
		method: "GET" | "POST";
		captureId?: string;
		generation?: string;
		mode?: "restore" | "roundtrip";
	},
): Promise<CmsSiteRestoreStatus> {
	const url = new URL(
		`https://cms.internal/api/internal/deployments/${encodeURIComponent(args.slug)}/site-restores`,
	);
	url.searchParams.set("siteId", args.siteId);
	if (args.generation) url.searchParams.set("generation", args.generation);
	const response = await env.CMS.fetch(
		new Request(url, {
			method: args.method,
			headers: {
				Authorization: `Bearer ${env.PLATFORM_SERVICE_TOKEN}`,
				"X-Tedix-Connection-Label": args.slug,
				...(args.method === "POST"
					? { "Content-Type": "application/json" }
					: {}),
			},
			...(args.method === "POST"
				? {
						body: JSON.stringify({
							siteId: args.siteId,
							captureId: args.captureId,
							mode: args.mode,
						}),
					}
				: {}),
		}),
	);
	const data = (await response.json()) as Partial<CmsSiteRestoreStatus> & {
		ok?: boolean;
	};
	if (
		!response.ok ||
		data.ok !== true ||
		data.siteId !== args.siteId ||
		(args.captureId && data.captureId !== args.captureId) ||
		(args.generation && data.generation !== args.generation) ||
		!data.captureId ||
		!data.generation ||
		!RESTORE_PHASES.has(data.phase as CmsSiteRestoreStatus["phase"]) ||
		!data.createdAt ||
		!data.updatedAt
	)
		throw new Error(`CMS restore service returned ${response.status}`);
	return {
		siteId: data.siteId,
		captureId: data.captureId,
		generation: data.generation,
		phase: data.phase!,
		createdAt: data.createdAt,
		updatedAt: data.updatedAt,
		...(data.errorCode ? { errorCode: data.errorCode } : {}),
	};
}

export async function startCmsSiteRestore(
	env: CmsRecoveryEnv,
	args: {
		slug: string;
		siteId: string;
		captureId: string;
		mode: "restore" | "roundtrip";
	},
): Promise<CmsSiteRestoreStatus> {
	return callSiteRestore(env, { ...args, method: "POST" });
}

export async function getCmsSiteRestore(
	env: CmsRecoveryEnv,
	args: { slug: string; siteId: string; generation: string },
): Promise<CmsSiteRestoreStatus> {
	return callSiteRestore(env, { ...args, method: "GET" });
}
