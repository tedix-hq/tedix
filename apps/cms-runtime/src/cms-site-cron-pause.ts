import {
	CMS_SITE_DRILL_SITE_ID,
	CMS_SITE_DRILL_SLUG,
	readSiteDrillReceipt,
} from "./cms-site-restore-drill-workflow";

export const CMS_SITE_CRON_PAUSE_KEY = `recovery/site-drills/${CMS_SITE_DRILL_SITE_ID}/cron-pause.json`;
export const CMS_SITE_CRON_PAUSE_MAX_MS = 2 * 60 * 60 * 1000;

interface CmsSiteCronPauseControl {
	version: 1;
	siteId: typeof CMS_SITE_DRILL_SITE_ID;
	slug: typeof CMS_SITE_DRILL_SLUG;
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
	now: number,
): value is CmsSiteCronPauseControl {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const control = value as Partial<CmsSiteCronPauseControl>;
	if (
		control.version !== 1 ||
		control.siteId !== CMS_SITE_DRILL_SITE_ID ||
		control.slug !== CMS_SITE_DRILL_SLUG ||
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

/** Private pause for the one disposable restore drill. An unreadable control or
 * receipt cannot permit scheduled writes while its recovery state is unknown. */
export async function fixedSiteCronPauseDecision(
	storage: R2Bucket,
	identity: { siteId: string; slug: string },
	now = Date.now(),
): Promise<CmsSiteCronPauseDecision> {
	if (
		identity.siteId !== CMS_SITE_DRILL_SITE_ID ||
		identity.slug !== CMS_SITE_DRILL_SLUG
	)
		return { pause: false };

	try {
		const object = await storage.get(CMS_SITE_CRON_PAUSE_KEY);
		if (object) {
			const control = (await object.json()) as unknown;
			if (!isValidControl(control, now))
				return { pause: true, reason: "invalid-control" };
			if (Date.parse(control.expiresAt) > now)
				return { pause: true, reason: "active-control" };
		}
		const receipt = await readSiteDrillReceipt(storage);
		return receipt && receipt.phase !== "verified"
			? { pause: true, reason: "unfinished-drill" }
			: { pause: false };
	} catch {
		return { pause: true, reason: "invalid-control" };
	}
}
