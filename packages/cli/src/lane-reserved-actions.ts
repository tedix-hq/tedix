import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";

/**
 * Which human-reserved actions a Work Item asks a local lane to perform.
 *
 * The shared classifier flags any mention of consent, credentials, sending or
 * deleting, which is right for a single tool call but wrong for a code task
 * that describes those subjects ("fix the consent check", "move the GitHub
 * token out of the container"). A lane only holds an item when its text,
 * outside negated clauses, tells the executor to do the act itself: grant or
 * revoke consent, issue, rotate or enter credentials, pay, send an outside
 * message, publish, delete live data or change live customer config. Classes
 * without a lane act rule stay as the shared classifier reports them.
 */
export function laneReservedActions(text: string): string[] {
	const instructions = withoutNegatedClauses(text);
	return [
		...humanReservedActionClasses(instructions).filter(
			(id) => !(id in actRules),
		),
		...Object.entries(actRules)
			.filter(([, rules]) => rules.some((rule) => rule.test(instructions)))
			.map(([id]) => id),
	];
}

/** Text with its negated clauses removed: "never X", "do not X", "no X, Y or Z." */
export function withoutNegatedClauses(text: string): string {
	return text.replace(negatedClause, " ").replace(negatedList, " ");
}

/** An instruction to the executor to perform consent, MFA or a sign-in step. */
export const userPresenceStep =
	/\b(?:complete|approve|grant|give|pass|perform|finish|enter|type|accept)\s+(?:(?:the|an?|your|my|their|its)\s+)?(?:oauth\s+|login\s+|sign[- ]?in\s+)?(?:mfa|2fa|otp|consent|passkey|password|captcha)\b/i;

const negatedClause =
	/\b(?:never|do not|don't|don’t|does not|doesn't|must not|cannot|can't|can’t|won't|without|not)\b[^.;!?\n]*/gi;

// "No submission, external sending, consent, payment or publication." A list
// of at least two short items, or one item that "is authorised" or names
// "changes", is a prohibition; "No rush, pay the invoice" stays an instruction.
const listItem = String.raw`[\w/'’-]+(?:[ \t]+[\w/'’-]+){0,6}`;
const negatedList = new RegExp(
	String.raw`\bno[ \t]+(?!(?:problem|problems|worries|rush|hurry|need|doubt|wait|way|matter|pressure|question|questions)\b)(?:${listItem}(?:[ \t]*(?:,|\bor\b|\band\b|\bnor\b)[ \t]*${listItem})+|${listItem}[ \t]+(?:is|are)[ \t]+(?:authori[sz]ed|allowed|permitted|needed|required)|(?:[\w/'’-]+[ \t]+){0,3}(?:changes?|writes?|edits?|effects?))(?=[ \t]*(?:[.;!?\n]|$))`,
	"gi",
);

const anyWords = String.raw`(?:[\w'’-]+[ \t]+){0,3}`;

const actRules: Record<string, RegExp[]> = {
	credentials: [
		userPresenceStep,
		new RegExp(
			String.raw`\b(?:grant|give|revoke|withdraw|accept|approve|complete|authori[sz]e|re-?authori[sz]e|click through)[ \t]+${anyWords}(?:consent|oauth|scopes?|access|authori[sz]ation)\b`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:issue|re-?issue|rotate|roll|mint|regenerate|create|generate|enter|type|paste|provide|supply|reset|revoke|share|upload|export|print)[ \t]+${anyWords}(?:credentials?|passwords?|secrets?|api[ -]keys?|keys?|tokens?|pats?|private keys?)\b(?![ \t-]+(?:exchange|module|handler|cache|resolution|lookup|refresh|store|path|file|header|injection|broker|flow|endpoint|route|check|validation|tests?|type|schema|format))`,
			"i",
		),
		/\b(?:wrangler|gh)\s+secret\s+(?:put|set)\b/i,
		/\b(?:log|sign)[ -]?(?:in|on)(?:to)?[ \t]+(?:to|into|at|on|with|as|using)\b/i,
		/(?<![\w.-])\.(?:env|dev\.vars)(?![\w-]*\.(?:example|sample|template)\b)(?![\w-])/i,
	],
	money: [
		/\b(?:pay|purchase|buy|refund|wire)\b(?!-)/i,
		/\btransfer[ \t]+(?:the[ \t]+)?(?:money|funds|payment|[$€£]\s*\d|\d+[ \t]*(?:eur|usd|€|\$))/i,
		/\bcharge[ \t]+(?:the|an?)?[ \t]*(?:customer|client|card|user|account)\b/i,
		/\b(?:approve|settle|void|issue)[ \t]+(?:(?:an?|the|pending)[ \t]+)?invoices?\b/i,
		/\b(?:raise|increase|lower|set|adjust|reduce|allocate|grant|top up)[ \t]+(?:the[ \t]+)?(?:budgets?|credits?|credit[ \t]+billing)\b/i,
		/\b(?:upgrade|downgrade|cancel|subscribe to)[ \t]+(?:the|our|a)?[ \t]*(?:plan|subscription|seat)/i,
	],
	external_message: [
		/\b(?:send|email|e-mail|message|dm|reply(?:[ \t]+to)?|write[ \t]+to|reach[ \t]+out[ \t]+to|contact|ping)\b[^.;!?\n]{0,40}\b(?:customers?|clients?|prospects?|leads?|investors?|partners?|recipients?|contacts?|person|people|someone|them|him|her|outside|external|whatsapp|instinct|slack|discord|teams|linkedin|reddit|e-?mails?|inbox|sms)\b/i,
		/\bwhatsapp\b[^.;!?\n]{0,80}\b(?:send|message|ask|reply)\b/i,
		/\bimpersonat\w*/i,
	],
	public_publish: [
		/(?<!\b(?:can|could|may|might)[ \t]+)\bpublish(?:es|ing)?\b(?!-|[ \t]+(?:(?:the|a|an|one|its|this)[ \t]+)?(?:workspace[ \t]+output|output|feed|today|internal|draft|findings[ \t]+in[ \t]+os))/i,
		/\b(?:npm|bun|pnpm|cargo|gh)[ \t]+(?:publish|release[ \t]+create)\b/i,
		/\bpost[ \t]+(?:\w+[ \t]+){0,4}(?:public|publicly|social|linked[ \t]*in|reddit|tweet|blog|hacker[ \t]*news)\b/i,
		/\b(?:tweet|github[ \t]+merge[ \t]+pull[ \t]+request)\b/i,
	],
	delete_data: [
		/\b(?:(?:delet|purg|wip|truncat|trash|destroy|eras|remov)\w*|drop(?:s|ped|ping)?)\b[^.;!?\n]{0,60}\b(?:data|rows?|records?(?![ \t]+(?:why|what|how|that|whether|it|its|the|an?)\b)|tables?|database|d1|r2|kv|buckets?|archives?|backups?|snapshots?|e-?mails?|messages?|users?|accounts?|tenants?|organi[sz]ations?|customers?|memor(?:y|ies)|history|logs?|uploads?)\b/i,
		/\b(?:data|rows?|records?|tables?|database|buckets?|archives?|backups?|snapshots?|e-?mails?|accounts?|tenants?|customers?)\b[^.;!?\n]{0,40}\b(?:are|is|get|be)[ \t]+(?:deleted|purged|dropped|wiped|gone|removed)\b/i,
	],
	legal: [
		/\b(?:sign|accept|execute|enter[ \t]+into|agree[ \t]+to)[ \t]+(?:[\w'’-]+[ \t]+){0,2}(?:contracts?|agreements?|terms|nda|dpa|offers?|binding)\b/i,
		/\blegal(?:ly)?[ \t]+(?:assertion|claim|commitment|binding)\b/i,
	],
	// A live customer's settings, not the code or fixtures behind them.
	customer_config: [
		/\b(?:change|update|set|edit|modify|configure|reconfigure|flip|toggle|enable|disable)\b[^.;!?\n]{0,40}\b(?:live|production|prod)[ \t]+(?:customer|tenant|client|org(?:anization)?)(?:'s)?[ \t]+(?:\w+[ \t]+){0,2}(?:config(?:uration)?|settings?|polic(?:y|ies)|plan|installation|connections?)\b/i,
	],
};
