import {
	readSiteDrillReceipt,
	type CmsSiteDrillIdentity,
} from "./cms-site-restore-drill-workflow";

export const CMS_SITE_CRON_PAUSE_MAX_MS = 2 * 60 * 60 * 1000;

export function cmsSiteCronPauseKey(
	drill: Pick<CmsSiteDrillIdentity, "siteId">,
): string {
	return `recovery/site-drills/${drill.siteId}/cron-pause.json`;
}

interface CmsSiteCronPauseControl {
	version: 1;
	siteId: string;
	slug: string;
	createdAt: string;
	expiresAt: string;
}

export type CmsSiteCronPauseDecision =
	| { pause: false }
	| {
			pause: true;
			reason: "active-control" | "unfinished-drill" | "invalid-control";
	  };

function isValidControl(
	value: unknown,
	drill: CmsSiteDrillIdentity,
	now: number,
): value is CmsSiteCronPauseControl {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const control = value as Partial<CmsSiteCronPauseControl>;
	if (
		control.version !== 1 ||
		control.siteId !== drill.siteId ||
		control.slug !== drill.slug ||
		typeof control.createdAt !== "string" ||
		typeof control.expiresAt !== "string"
	)
		return false;
	const createdAt = Date.parse(control.createdAt);
	const expiresAt = Date.parse(control.expiresAt);
	return (
		Number.isFinite(createdAt) &&
		Number.isFinite(expiresAt) &&
		new Date(createdAt).toISOString() === control.createdAt &&
		new Date(expiresAt).toISOString() === control.expiresAt &&
		createdAt <= now &&
		expiresAt > createdAt &&
		expiresAt - createdAt <= CMS_SITE_CRON_PAUSE_MAX_MS
	);
}

/** Private pause for the configured disposable restore drill. An unreadable
 * control or receipt cannot permit scheduled writes while its recovery state
 * is unknown. A null drill means no drill site is currently designated. */
export async function fixedSiteCronPauseDecision(
	storage: R2Bucket,
	identity: { siteId: string; slug: string },
	drill: CmsSiteDrillIdentity | null,
	now = Date.now(),
): Promise<CmsSiteCronPauseDecision> {
	if (
		!drill ||
		identity.siteId !== drill.siteId ||
		identity.slug !== drill.slug
	)
		return { pause: false };

	try {
		const object = await storage.get(cmsSiteCronPauseKey(drill));
		if (object) {
			const control = (await object.json()) as unknown;
			if (!isValidControl(control, drill, now))
				return { pause: true, reason: "invalid-control" };
			if (Date.parse(control.expiresAt) > now)
				return { pause: true, reason: "active-control" };
		}
		const receipt = await readSiteDrillReceipt(storage, drill);
		return receipt && receipt.phase !== "verified"
			? { pause: true, reason: "unfinished-drill" }
			: { pause: false };
	} catch {
		return { pause: true, reason: "invalid-control" };
	}
}
