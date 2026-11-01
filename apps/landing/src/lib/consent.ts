export const CONSENT_KEY = "tedix.cookieConsent.v1";
export const CONSENT_VERSION = 1;
export const CONSENT_EVENT = "tedix:consentchange";

export interface ConsentRecord {
	version: number;
	necessary: true;
	analytics: boolean;
	updatedAt: string;
}

export function parseConsent(value: string | null): ConsentRecord | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		if (parsed?.version !== CONSENT_VERSION) return null;
		return parsed;
	} catch {
		return null;
	}
}

type ConsentStorage = Pick<Storage, "getItem" | "setItem">;

export function readConsent(
	storage: ConsentStorage | undefined,
): ConsentRecord | null {
	try {
		return parseConsent(storage?.getItem(CONSENT_KEY) ?? null);
	} catch {
		return null;
	}
}

export function createConsent(
	analytics: boolean,
	date = new Date(),
): ConsentRecord {
	return {
		version: CONSENT_VERSION,
		necessary: true,
		analytics: Boolean(analytics),
		updatedAt: date.toISOString(),
	};
}

export function writeConsent(
	storage: ConsentStorage | undefined,
	consent: ConsentRecord,
): void {
	try {
		storage?.setItem(CONSENT_KEY, JSON.stringify(consent));
	} catch {
		// If storage is unavailable, keep the choice for this page only.
	}
}
