const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DemandIntake {
	email: string;
	process: string;
	currentOwner: string;
	systems: string;
	context?: string;
	consent: true;
	website: string;
	pageUrl?: string;
	referrer?: string;
	utmSource?: string;
	utmMedium?: string;
	utmCampaign?: string;
	utmContent?: string;
	utmTerm?: string;
}

export type DemandIntakeParseResult =
	| { ok: true; data: DemandIntake }
	| { ok: false; error: string };

function textField(
	value: unknown,
	maxLength: number,
	required = false,
): string | null {
	if (typeof value !== "string") return required ? null : "";
	const normalized = value.trim().replace(/\r\n/g, "\n");
	if (required && normalized.length === 0) return null;
	if (normalized.length > maxLength) return null;
	return normalized;
}

export function parseDemandIntake(input: unknown): DemandIntakeParseResult {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: "Provide the contact form fields." };
	}
	const body = input as Record<string, unknown>;
	const email = textField(body.email, 320, true);
	const process = textField(body.process, 2_000, true);
	const currentOwner = textField(body.currentOwner, 300, true);
	const systems = textField(body.systems, 1_000, true);
	if (!email || !EMAIL_PATTERN.test(email)) {
		return { ok: false, error: "Provide a valid email address." };
	}
	if (!process || !currentOwner || !systems) {
		return {
			ok: false,
			error:
				"Describe the process, its current owner, and the systems involved.",
		};
	}
	if (body.consent !== true) {
		return {
			ok: false,
			error: "Confirm that Tedix may contact you about this process.",
		};
	}

	const optional = (key: string, maxLength: number) =>
		textField(body[key], maxLength) ?? "";
	return {
		ok: true,
		data: {
			email: email.toLowerCase(),
			process,
			currentOwner,
			systems,
			context: optional("context", 4_000) || undefined,
			consent: true,
			website: optional("website", 500),
			pageUrl: optional("pageUrl", 2_000) || undefined,
			referrer: optional("referrer", 2_000) || undefined,
			utmSource: optional("utmSource", 300) || undefined,
			utmMedium: optional("utmMedium", 300) || undefined,
			utmCampaign: optional("utmCampaign", 300) || undefined,
			utmContent: optional("utmContent", 300) || undefined,
			utmTerm: optional("utmTerm", 300) || undefined,
		},
	};
}

async function sha256Hex(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function demandSourceIntentId(
	email: string,
	process: string,
): Promise<string> {
	const fingerprint = await sha256Hex(
		`${email.trim().toLowerCase()}\n${process.trim().toLowerCase()}`,
	);
	return `landing-demand:${fingerprint}`;
}

export async function demandRateLimitKey(ip: string): Promise<string> {
	const fingerprint = await sha256Hex(`tedix-demand-intake|${ip}`);
	return `demand-intake:${fingerprint.slice(0, 32)}`;
}

export function demandWorkItemTitle(process: string): string {
	const oneLine = process.replace(/\s+/g, " ").trim();
	const suffix = oneLine.length > 96 ? `${oneLine.slice(0, 93)}…` : oneLine;
	return `Qualify recurring process: ${suffix}`;
}

export function isSyntheticDemand(email: string): boolean {
	return email.toLowerCase().endsWith("@example.invalid");
}
