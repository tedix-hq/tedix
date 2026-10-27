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

/**
 * Text with its negated clauses removed: "never X", "do not X", "no X, Y or
 * Z." Urgency idioms ("do not wait —", "no need to ask,", "without delay,")
 * negate only themselves, so the instruction after them survives.
 */
export function withoutNegatedClauses(text: string): string {
	return plainText(text)
		.replace(urgencyIdiom, " ")
		.replace(negatedClause, " ")
		.replace(negatedList, " ");
}

/**
 * Compatibility-folded text with zero-width characters removed, so look-alike
 * letters, full-width forms and invisible joins cannot hide a verb.
 */
function plainText(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[​-‍⁠﻿­]/g, "")
		.replace(/[  -   　]/g, " ")
		.replace(/[‐-―−]/g, (dash) => (dash === "—" || dash === "―" ? " — " : "-"));
}

/** An instruction to the executor to perform consent, MFA or a sign-in step. */
export const userPresenceStep =
	/\b(?:complete|approve|grant|give|pass|perform|finish|enter|type|paste|accept|click|solve|scan|tap|confirm|answer|redo|re-do|do|go[ \t]+through|click[ \t]+through)\s+(?:(?:the|an?|your|my|their|its|our)\s+)?(?:oauth\s+|login\s+|sign[- ]?in\s+|verification\s+|sms\s+|e-?mail\s+|authenticator\s+|security\s+|device\s+|consent\s+|mfa\s+|2fa\s+)?(?:mfa|2fa|otp|totp|consent|passkey|password|captcha|qr[ -]?code|touch[ -]?id|face[ -]?id|security[ \t]+key|authenticator|login|sign[- ]?in|oauth(?:[ \t]+(?:flow|dance|screen|prompt))?|consent[ \t]+(?:screen|prompt|dialog)|verification[ \t]+code|sms[ \t]+code|e-?mail[ \t]+code|device|push[ \t]+notification)\b|\b(?:enter|type|paste|read[ \t]+out|answer)[ \t]+(?:the[ \t]+)?(?:\w+[ \t]+)?code\b(?![ \t]+(?:path|base|review|change|style|owner|block|sample|snippet|point))|\buse[ \t]+(?:the|your|my|an?)?[ \t]*(?:passkey|touch[ -]?id|face[ -]?id|security[ \t]+key|authenticator)\b(?![ \t]+(?:mock|stub|fake|test|fixture|component|module|class))|\bclick[ \t]+(?:on[ \t]+)?(?:["'“]?)(?:allow|approve|accept|authori[sz]e|continue[ \t]+with[ \t]+google|sign[ \t]+in[ \t]+with)\b|\bconsent[ \t]+to\b(?![^.;!?\n]*\b(?:checkbox|label|form|page|component|copy|text|ui|string|wording)\b)|(?:^|[.;!\n][ \t]*)(?:please[ \t]+)?(?:log|sign)[ -]?(?:in|on)[ \t]*(?:[.!;\n]|$)/i;

// "Do not wait —", "don't hesitate,", "no need to ask;", "without delay:",
// "not a drill:", "it is not optional —". The negation covers only the idiom.
const negation = String.raw`\b(?:never|do not|don't|does not|doesn't|must not|cannot|can't|won't|without|not|nicht|ohne)\b`;
const urgencyIdiom = new RegExp(
	String.raw`(?:${negation}|\b(?:no|kein(?:e|en)?)\b)[ \t]+(?:(?:even|further|a|an|the|any|more|longer)[ \t]+){0,2}(?:(?:forget|hesitate|fail|wait|bother|need|neglect)[ \t]+to\b|(?:wait(?:ing)?|hesitat\w*|delay\w*|stall\w*|paus\w*|ask\w*|forget\w*|worr\w*|bother\w*|hold[ \t]+(?:back|off)|stop\w*|drill|optional|negotiable|now|say[ \t]+no|questions?[ \t]+asked|discussion|excuses?|confirmation|approval[ \t]+needed|need[ \t]+to[ \t]+(?:ask|wait|check|confirm)|(?:[\w-]+[ \t]+)?(?:needed|required|necessary)|rush|hurry|just|merely|only|simply|zögern|warten|fragen|(?:r[üu]ck)?frage|verz[öo]gerung)\b(?:[ \t]+(?:for|on|about|with|um|auf|zu)\b)?[^,;:.!?\n—]*[,;:—]?)`,
	"gi",
);

const negatedClause = new RegExp(
	String.raw`(?:${negation}|\b(?:niemals|nie|kein(?:e|en|er|es)?)\b)[^.;!?\n]*`,
	"gi",
);

// "No submission, external sending, consent, payment or publication." A list
// of at least two short items, or one item that "is authorised" or names
// "changes", is a prohibition; "No rush, pay the invoice" stays an instruction.
const listItem = String.raw`[\w/'’-]+(?:[ \t]+[\w/'’-]+){0,6}`;
const negatedList = new RegExp(
	String.raw`\bno[ \t]+(?!(?:problem|problems|worries|rush|hurry|need|doubt|wait|way|matter|pressure|question|questions|one|longer|more)\b)(?:${listItem}(?:[ \t]*(?:,|\bor\b|\band\b|\bnor\b)[ \t]*${listItem})+|${listItem}[ \t]+(?:is|are)[ \t]+(?:authori[sz]ed|allowed|permitted|needed|required)|(?:[\w/'’-]+[ \t]+){0,3}(?:changes?|writes?|edits?|effects?))(?=[ \t]*(?:[.;!?\n]|$))`,
	"gi",
);

const anyWords = String.raw`(?:[\w'’-]+[ \t]+){0,3}`;
const inSentence = String.raw`[^.;!?\n]`;
// Nouns after a credential word that make it a code subject, not a secret.
const codeSubject = String.raw`(?![ \t-]+(?:exchange|hash|requirements?|rules?|polic(?:y|ies)|strength|complexity|hashes|hashing|map|salt|length|strength|entropy|module|handler|cache|resolution|lookup|refresh|store|path|file|header|injection|broker|flow|endpoint|route|check|validation|tests?|type|schema|format|field|column|table|parser|parsing|helper|util|service|class|function|logic|bug|error|issue|leak|audit|scan|scanner|rule|policy|manager|page|form|input|prompt|ui|screen|component|docs?|readme|guide|section))`;
const credentialNoun = String.raw`(?:credentials?|passwords?|passphrases?|secrets?|(?:api|access|private|ssh|signing|deploy|service[ -]account|client|stripe|cloudflare|descope|openai|anthropic|gpg|pgp|license|licence)[ -]keys?|tokens?|pats?|certificates?|zugangsdaten|passw(?:o|ö)rt(?:er)?|api-schl(?:ü|u)ssel)`;
const outsideParty = String.raw`(?:customers?|clients?|prospects?|leads?|investors?|partners?|recipients?|contacts?|suppliers?|vendors?|contractors?|applicants?|candidates?|subscribers?|person|people|someone|them|him|her|outside|external|whatsapp|instinct|slack|discord|teams|linkedin|reddit|e-?mails?|inbox|sms|kunden?|kundin|lieferanten?)`;
const partyAsCode = String.raw`(?![ \t-]+(?:side|component|library|lib|sdk|code|bundle|as[ \t]+json|app\b|module|field|template|form|parsing|parser|list|table|column|type|schema|fixture|flow|page|route|handler|mock|tests?|address[ \t]+field|validation|regex|normali[sz]ation))`;
const emailAddress = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`;
const internalName = String.raw`(?:Tedix|Output|Workspace|OS|Feed|Deck|Work|Claude|Codex|Devin|OpenCode|GitHub|Cloudflare|D1|R2|KV|Descope|Stripe|Sentry|Home|Hub|Today|Activity|Notion)`;

const actRules: Record<string, RegExp[]> = {
	credentials: [
		userPresenceStep,
		new RegExp(
			String.raw`\b(?:grant|give|revoke|withdraw|accept|approve|complete|authori[sz]e|re-?authori[sz]e|click through|erteile|erteilen|widerrufe|widerrufen)[ \t]+${anyWords}(?:consent|oauth|scopes?|access|authori[sz]ation|grants?|sessions?|einwilligung|zustimmung|freigabe|zugriff)\b(?![^.;!?\n]*\b(?:check|checks|handler|route|tests?|fixture|helper|module|function|logic|flow|page|ui|component|schema|type|logout|code)\b)`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:issue|re-?issue|rotate|roll|mint|re-?mint|regenerate|create|generate|enter|type|paste|provide|supply|reset|revoke|share|upload|export|print|push|put|install|inject|replace|renew|obtain|request|provision|hand|give|send|change|dump|rotiere|rotieren|erstelle|erstellen|erzeuge|erzeugen|ändere|ändern|setze|setzen|teile|teilen|gib|geben|schicke|sende)[ \t]+${anyWords}${credentialNoun}\b${codeSubject}`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:issue|re-?issue|rotate|roll|mint|re-?mint|regenerate|revoke|rotiere|rotieren)[ \t]+${anyWords}(?:keys?|schl(?:ü|u)ssel)\b${codeSubject}`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:wrangler|gh|npx[ \t]+wrangler|bunx[ \t]+wrangler)\s+secret\s+(?:put|set|bulk)\b|\bwrangler\s+secret\s+bulk\b`,
			"i",
		),
		/\b(?:log|sign)(?:[ -]?(?:in|on)[ \t]+(?:to|into|at|on|with|as|using|via|through)|[ \t]*into)\b/i,
		new RegExp(
			String.raw`\b(?:get|fetch|obtain|make|request|provision|create|generate|issue|mint|set|choose|update|change)[ \t]+(?:a|an|the|your|my)?[ \t]*(?:new|fresh|production|prod|live|stronger)[ \t]+(?:${credentialNoun}|keys?)\b${codeSubject}`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:add|set|store|save|put|upload|paste|copy|install|push)[ \t]+${anyWords}(?:${credentialNoun}|keys?)\b[ \t]+(?:to|in|into|on|onto|via|with|through)[ \t]+(?:the[ \t]+)?(?:[\w'’-]+[ \t]+){0,3}(?:secrets?|vault|1password|bitwarden|keychain|dashboard|github|gitlab|settings|console|env|environment|envs?|worker|workers|production|prod|live|wrangler|ci|actions)\b`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:set|update|change|reset|choose)[ \t]+(?:a|an|the|your|my|her|his|their)?[ \t]*(?:new[ \t]+)?(?:admin[ \t]+|root[ \t]+|owner[ \t]+)?passwords?\b${codeSubject}`,
			"i",
		),
		/\b(?:run|complete|finish|redo|perform)[ \t]+(?:the[ \t]+)?(?:login|sign[- ]?in|oauth|consent)\b(?![ \t-]+(?:tests?|fixture|mock|flow[ \t]+tests?|page[ \t]+tests?))/i,
		/\b(?:confirm|verify|approve)[ \t]+with[ \t]+(?:the|your|a)?[ \t]*(?:passkey|touch[ -]?id|face[ -]?id|security[ \t]+key|authenticator|mfa|2fa|otp)\b/i,
		/\b(?:bypass|defeat|solve|beat)[ \t]+(?:the|a)?[ \t]*captcha\b/i,
		/\bremove[ \t]+(?:the|your|my|their|an?)?[ \t]*(?:[\w'’-]+[ \t]+)?(?:consent|oauth[ \t]+grant|grant|authori[sz]ation)\b(?![ \t-]+(?:check|checks|handler|route|tests?|fixture|helper|module|function|logic|flow|page|ui|component|schema|type|code|copy|text|label))/i,
		/\b(?:run|execute|use)[ \t]+(?:`)?(?:tedix|gh[ \t]+auth|wrangler|npm|npx[ \t]+wrangler|gcloud(?:[ \t]+auth)?|az|aws[ \t]+sso|vercel|fly(?:ctl)?|heroku|docker|op[ \t]+signin|pass-cli)[ \t]+(?:login|signin)\b/i,
		/\b(?:re-?)?authenticate[ \t]+(?:to|with|at|on|as|against|yourself)\b(?![^.;!?\n]*\b(?:test|tests|fixture|mock|fake|facade|stub)\b)/i,
		new RegExp(
			String.raw`\b(?:authori[sz]e|connect|re-?connect|re-?authenticate|re-?authori[sz]e|link)[ \t]+(?:the|an?|your|my|our)?[ \t]*(?:[\w-]+[ \t]+)?(?:gmail|google|github|slack|notion|stripe|whatsapp|linkedin|microsoft|outlook|descope|cloudflare|hubspot|salesforce)[ \t]+(?:app|account|connection|connector|integration|workspace)\b${codeSubject}`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:${credentialNoun}|keys?)[ \t]+(?:is|are|gets?|be|been|must[ \t]+be|should[ \t]+be)[ \t]+(?:rotated|re-?issued|issued|minted|re-?minted|regenerated|reset|revoked|entered|rotiert)\b`,
			"i",
		),
		/(?<![\w.-])\.(?:env|dev\.vars)(?![\w-]*\.(?:example|sample|template)\b)(?![\w-])/i,
		/\b(?:melde|logge)[ \t]+dich[ \t]+(?:an|ein)\b|\b(?:anmelden|einloggen)[ \t]+(?:bei|auf|mit|als)\b/i,
	],
	money: [
		/\b(?:pay(?![ \t]+attention)|purchase|buy|refund|remit|bezahle|bezahlen|zahle|zahlen|überweise|überweisen|kaufe|kaufen|erstatte)\b(?!-)/i,
		/\bwire[ \t]+(?:the[ \t]+)?(?:money|funds|payment|[$€£]|\d)/i,
		/\btransfer[ \t]+(?:the[ \t]+)?(?:money|funds|payment|[$€£]\s*\d|\d+[ \t]*(?:eur|usd|€|\$))/i,
		/\bcharge[ \t]+(?:the|an?)?[ \t]*(?:customer|client|card|user|account|them|him|her)\b/i,
		/\b(?:charge|spend|donate|tip|transfer|top[ \t]+up)\b[^.;!?\n]{0,20}(?:[$€£]\s*\d|\d+(?:[.,]\d+)?[ \t]*(?:eur|usd|gbp|€|\$|£|k\b))/i,
		/\b(?:bill|invoice)[ \t]+(?:the[ \t]+)?(?:customer|client|them|him|her)\b(?!-)/i,
		/\b(?:approve|settle|void|issue|release)[ \t]+(?:(?:an?|the)[ \t]+)?(?:(?:pending|open|overdue|supplier|vendor)[ \t]+)?invoices?\b/i,
		/\b(?:invoices?|bills?|suppliers?|vendors?|contractors?|rechnung(?:en)?)\b[^.;!?\n]{0,30}\b(?:is|are|gets?|be|been|must[ \t]+be|should[ \t]+be)[ \t]+(?:paid|settled|reimbursed|bezahlt)\b/i,
		/\bpayouts?\b(?![ \t-]+(?:table|ledger|column|row|model|schema|type|fixture|test|page|ui|list|history))/i,
		/\bsettle[ \t]+up\b/i,
		/\badd[ \t]+[$€£]?\d+(?:[.,]\d+)?[ \t]*(?:eur|usd|gbp|€|\$|£)?[ \t]+(?:of[ \t]+|in[ \t]+)?credits?\b/i,
		/\b(?:launch|run|start|book)[ \t]+(?:the|an?|our)[ \t]+(?:\w+[ \t]+)?(?:ad|ads|advertising|paid)[ \t]+campaigns?\b/i,
		/\b(?:make|execute|release|remit|approve|authori[sz]e|complete|initiate|trigger|confirm)[ \t]+(?:the|an?|this|that)?[ \t]*(?:\w+[ \t]+)?(?:payments?|payouts?|bank[ \t]+transfers?|wire[ \t]+transfers?|checkout|purchase|order)\b/i,
		/\b(?:raise|increase|lower|set|adjust|reduce|allocate|grant|top[ \t]+up|refill)[ \t]+(?:the[ \t]+)?(?:\w+[ \t]+)?(?:budgets?|credits?|credit[ \t]+billing|balance|funds)\b/i,
		/\btop[ \t]+up\b/i,
		/\b(?:upgrade|downgrade|cancel|subscribe to|switch)[ \t]+(?:the|our|a|us|to)?[ \t]*(?:plan|subscription|seat|pro\b|team\b|business\b|enterprise\b|paid\b|premium\b)(?![ \t-]+(?:picker|page|ui|component|selector|form|test|fixture|flow|model|schema|type|table|column|card|cleanup|handler|logic))/i,
		/\b(?:book|order)[ \t]+(?:the|an?|our)[ \t]+(?:flight|hotel|ticket|licen[cs]e|domain|seat|hardware|laptop|device|phone)s?\b(?![ \t-]+(?:picker|fixture|component|page|ui|form|test|mock|flow|list|table))/i,
	],
	external_message: [
		new RegExp(
			String.raw`\b(?:send|e-?mail|mail|message|dm|text|call|phone|forward|notify|invite|reply(?:[ \t]+to)?|respond(?:[ \t]+to)?|answer|write[ \t]+to|reach[ \t]+out[ \t]+to|contact|ping|schicke|schick|sende|schreibe|schreib|antworte|kontaktiere|benachrichtige|rufe)\b${inSentence}{0,40}\b${outsideParty}\b${partyAsCode}`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:[Ss]end|[Ee]-?mail|[Mm]ail|[Ff]orward|[Rr]eply|[Rr]espond|[Ww]rite|[Nn]otify|[Mm]essage|[Ss]chicke|[Ss]ende)\b${inSentence}{0,60}(?:${emailAddress}|\bto[ \t]+(?!${internalName}\b)[A-Z][a-z]+\b)`,
		),
		new RegExp(
			String.raw`\b(?:send|ship|mail|e-?mail|dispatch|fire[ \t]+off|blast)[ \t]+(?:out[ \t]+)?(?:the|an?|our|this)?[ \t]*(?:\w+[ \t]+)?(?:newsletter|campaign|quote|quotation|offer|proposal|invoice|reminder|follow-?up|outreach|mailing|cold[ \t]+e-?mails?)\b`,
			"i",
		),
		new RegExp(
			String.raw`\b(?:[Ee]-?mail|[Tt]ext|[Cc]all|[Pp]hone|DM|dm|[Mm]essage|[Pp]ing)[ \t]+(?!${internalName}\b)[A-Z][a-z]+\b(?!'s)(?![ \t]+(?:helper|function|method|hook|component|class|module|type|fixture|mock|stub|test|variable|object|handler|service|api|endpoint))`,
		),
		new RegExp(
			String.raw`\b${outsideParty}[ \t]+(?:must|should|will|to)?[ \t]*(?:receives?|gets?)\b${inSentence}{0,30}\b(?:e-?mails?|repl(?:y|ies)|quotes?|invoices?|newsletters?)\b${partyAsCode}|\b(?:is|are|gets?|be|been|was|were)[ \t]+(?:sent|e-?mailed|mailed|delivered|forwarded)[ \t]+(?:out|to|back)\b${inSentence}{0,40}\b${outsideParty}\b${partyAsCode}`,
			"i",
		),
		/\bwhatsapp\b[^.;!?\n]{0,80}\b(?:send|message|ask|reply)\b/i,
		/\bimpersonat\w*/i,
	],
	public_publish: [
		/(?<!\b(?:can|could|may|might)[ \t]+)\bpublish(?:es|ing)?\b(?!-|[ \t]+(?:(?:the|a|an|one|its|this)[ \t]+)?(?:workspace[ \t]+output|output|feed|today|internal|draft|findings[ \t]+in[ \t]+os))/i,
		/\b(?:is|are|gets?|be|been|was|were)[ \t]+published\b(?![ \t]+(?:to|in|as|on)[ \t]+(?:the[ \t]+)?(?:workspace|output|feed|os|tedix|today)\b)/i,
		/\b(?:npm|bun|pnpm|yarn|cargo|gh|changeset)[ \t]+(?:publish|release[ \t]+create)\b/i,
		/\bpost[ \t]+(?:\w+[ \t]+){0,4}(?:public|publicly|social|linked[ \t]*in|reddit|tweet|blog|hacker[ \t]*news)\b/i,
		/\b(?:post|share|comment|reply|announce|submit|launch|upload|cross-?post|promote)\b[^.;!?\n]{0,40}\b(?:on|to|in|at|via)[ \t]+(?:the[ \t]+)?(?:linked[ \t]*in|reddit|r\/\w+|x\b|twitter|hacker[ \t]*news|hn\b|product[ \t]*hunt|youtube|mastodon|bluesky|facebook|instagram|medium|dev\.to|substack|tiktok|threads|discord|slack[ \t]+community|the[ \t]+(?:public[ \t]+)?(?:blog|forum|changelog|docs[ \t]+site|website|landing[ \t]+page))\b/i,
		/\b(?:make|set|flip|switch|turn|change)\b[^.;!?\n]{0,30}\b(?:repo|repository|repos|org|project|workspace|page|site|output|doc|document|visibility|listing)s?\b[^.;!?\n]{0,20}\bpublic\b/i,
		/\bopen-?source[ \t]+(?:the|our|this)\b|\bpush(?:es|ing)?[ \t]+(?:\w+[ \t]+)?to[ \t]+(?:the|a)[ \t]+public[ \t]+(?:repo|repository|branch|package|registry)\b/i,
		/\b(?:tweet|github[ \t]+merge[ \t]+pull[ \t]+request|veröffentliche|veröffentlichen|publiziere|publizieren|poste)\b/i,
	],
	delete_data: [
		/\b(?:(?:delet|purg|wip|truncat|trash|destroy|eras|remov|lösch)\w*|drop(?:s|ped|ping)?)\b[^.;!?\n]{0,60}\b(?:data|rows?|records?(?![ \t]+(?:why|what|how|that|whether|it|its|the|an?)\b)|tables?|database|d1|r2|kv|buckets?|archives?|backups?|snapshots?|e-?mails?|messages?|users?|accounts?|tenants?|orgs?|organi[sz]ations?|customers?|memor(?:y|ies)|history|logs?|uploads?|namespaces?|live|production|prod|environments?|cloudflare[ \t]+\w+|workers?(?![ \t-]+(?:type|types|code|file|module|thread|threads|pool|script|config|entry|loader|class|test|tests))|daten|datenbank|zeilen|tabellen?|kunden)\b/i,
		/\b(?:data|rows?|records?|tables?|database|buckets?|archives?|backups?|snapshots?|e-?mails?|accounts?|tenants?|customers?|orgs?)\b[^.;!?\n]{0,40}\b(?:are|is|get|be)[ \t]+(?:deleted|purged|dropped|wiped|gone|removed)\b/i,
		/\b(?:DELETE[ \t]+FROM|DROP[ \t]+(?:TABLE|DATABASE|INDEX|SCHEMA)|TRUNCATE(?:[ \t]+TABLE)?)[ \t]+[\w"`.]+/i,
		/\bwrangler[ \t]+(?:d1|r2|kv(?::\w+)?|vectorize|queues)[ \t]+(?:\w+[ \t]+)?(?:delete|purge|drop)\b/i,
		/\b(?:deactivate|close|cancel|terminate|suspend|ban)[ \t]+(?:the|an?|their|his|her|this)?[ \t]*(?:[\w'’-]+[ \t]+)?(?:accounts?|users?|members?|tenants?|orgs?|organi[sz]ations?|customers?|subscriptions?)\b(?![ \t-]+(?:page|flow|button|route|handler|tests?|fixture|check|state|type|schema|modal|dialog|menu|item|list|row|card|icon|avatar|table|column|field|form|dropdown|picker|settings|profile|banner|cleanup|job|test[ \t]+job))/i,
		/\b(?:remove|delete|deactivate|kick|offboard)[ \t]+(?!the\b|an?\b)(?:[\w'’-]+[ \t]+)?(?:[A-Z][a-z]+)[ \t]+(?:from|out[ \t]+of)[ \t]+(?:the[ \t]+)?(?:org|organi[sz]ation|team|workspace|tenant|account|project)\b(?![^.;!?\n]*\b(?:fixture|tests?|seed|mock|fake)\b)/,
		new RegExp(
			String.raw`\b(?:[Dd]elete|[Dd]eactivate|[Bb]an|[Oo]ffboard|[Ss]uspend)[ \t]+(?!${internalName}\b)[A-Z][a-z]+(?:'s[ \t]+(?:account|access|user|login|seat))?[ \t]*(?:[.!,;]|$)`,
		),
	],
	legal: [
		/\b(?:counter-?sign|sign|accept|execute|enter[ \t]+into|agree[ \t]+to|terminate|cancel|renew|extend|unterschreibe|unterschreiben|unterzeichne|unterzeichnen|akzeptiere|kündige|kündigen)(?:[ \t]+(?:off[ \t]+on|and[ \t]+return))?[ \t]+(?:[\w'’-]+[ \t]+){0,2}(?:contracts?|agreements?|terms|nda|dpa|msa|sow|offers?|quotes?|quotations?|binding|lease|order[ \t]+forms?|engagement[ \t]+letters?|letters?[ \t]+of[ \t]+intent|offer[ \t]+letters?|vertrag|vertrags|vertrages|verträge|vereinbarung|angebot|agb)\b(?![ \t-]+(?:route|page|component|tests?|form|checkbox|label|ui|flow|job|fixture|schema|type|parser|copy|text|wording|template|step|modal|dialog|section))/i,
		/\bsign[ \t]+(?:it|this|them|here|below)\b/i,
		/\bgive[ \t]+(?:written[ \t]+|formal[ \t]+)?notice[ \t]+(?:on|to|of[ \t]+termination)\b/i,
		/\blegal(?:ly)?[ \t]+(?:assertion|claim|commitment|binding)\b/i,
		/\b(?:file|submit)[ \t]+(?:the|an?|our|this)[ \t]+(?:\w+[ \t]+)?(?:tax|vat|annual|regulatory|customs|elster)[ \t]+(?:\w+[ \t]+)?(?:return|filing|declaration|report)s?\b/i,
		/\b(?:file|submit|lodge)[ \t]+(?:the|an?|our|this)[ \t]+(?:\w+[ \t]+)?(?:bid|tender|application|claim|complaint|appeal|notice|dispute|objection)\b(?![ \t]+(?:form[ \t]+(?:component|page|route|ui)|flow|page|route|handler|test|schema|type))/i,
		/\bapply[ \t]+for[ \t]+(?:the|an?|our)[ \t]+(?:\w+[ \t]+)?(?:grant|loan|visa|permit|licen[cs]e|funding|programme|program|accelerator|credits?)\b/i,
		/\b(?:register|incorporate|trademark|found)[ \t]+(?:the|an?|our)[ \t]+(?:\w+[ \t]+)?(?:trademark|company|gmbh|gbr|ug|llc|entity|business|brand[ \t]+name)\b(?![ \t-]+(?:route|page|component|tests?|form|ui|flow|fixture|schema|type|field|column|table|name[ \t]+field))/i,
	],
	// A live customer's settings, not the code or fixtures behind them.
	customer_config: [
		/\b(?:change|update|set|edit|modify|configure|reconfigure|flip|toggle|enable|disable|switch|turn[ \t]+(?:on|off))\b[^.;!?\n]{0,40}\b(?:live|production|prod)[ \t]+(?:customer|tenant|client|org(?:anization)?)(?:'s)?[ \t]+(?:\w+[ \t]+){0,2}(?:config(?:uration)?|settings?|polic(?:y|ies)|plan|installation|connections?|flags?|features?|limits?|quotas?)\b/i,
		/\b(?:change|update|set|edit|modify|configure|reconfigure|flip|toggle|enable|disable|switch|turn[ \t]+(?:on|off))\b(?=[^.;!?\n]{0,80}\b(?:live|production|prod)\b)(?=[^.;!?\n]{0,80}\b(?:customer|tenant|client)s?\b)[^.;!?\n]{0,80}\b(?:config(?:uration)?|settings?|polic(?:y|ies)|plan|installation|connections?|flags?|features?|limits?|quotas?|sso|billing|domain|rules?)\b(?![ \t-]+(?:code|tests?|fixtures?|schema|type|route|handler|module|component|page|readme|docs?|parser|loader|validation|migration))/i,
		/\b(?:change|update|set|edit|modify|configure|flip|toggle|enable|disable)\b[^.;!?\n]{0,30}\bfor[ \t]+(?:the[ \t]+)?(?:live|production|prod)[ \t]+(?:customer|tenant|client|org(?:anization)?)\b/i,
	],
};
