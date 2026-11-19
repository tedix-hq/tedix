/**
 * What an organization admin reads when its monthly credits reach 80% or
 * 100%: the same words on the Deck card and in the email.
 */

import type { CreditNoticeThreshold } from "./credit-pricing";

/** Settings › Billing › Usage in Tedix OS. */
export const CREDIT_NOTICE_PATH = "/admin/billing";
export const CREDIT_NOTICE_LINK_LABEL = "Settings › Billing › Usage";

export interface CreditNoticeCopy {
	/** One line, led by the percentage. */
	subject: string;
	/** The 2–3 sentence story, without the link. */
	story: string;
}

export function creditNoticeCopy(input: {
	threshold: CreditNoticeThreshold;
	organizationName?: string | null;
}): CreditNoticeCopy {
	const who = input.organizationName?.trim() || "Your organization";
	const subject = `${who} has used ${input.threshold}% of this month's credits`;
	const next = "Buy a credit pack or turn on pay-as-you-go to keep working.";
	const story =
		input.threshold === 100
			? `${subject}. Tedis and code runs now pause until the month resets, unless a credit pack or pay-as-you-go covers them. ${next}`
			: `${subject}. At 100%, tedis and code runs pause until the month resets. ${next}`;
	return { subject, story };
}
