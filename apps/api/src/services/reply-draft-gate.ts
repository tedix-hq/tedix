/**
 * Clef delivery gate for tedi-drafted replies.
 *
 * The drafting tedi's own `reversible` flag is not trusted on its own: before
 * a draft may be sent without review, an independent Clef decision model
 * scores the agent's message and the drafted reply against the policy's
 * `deliveryGate` checks. Every check must pass. A model error, timeout, or
 * malformed answer is `unavailable`, which the caller delivers as `review`
 * (fail closed). The result is stored on the draft for audit.
 */

import type {
	AgentReplyDeliveryGatePolicy,
	AgentReplyDeliveryGateResult,
} from "@tedix/api-contract/schemas/agent-turn-triage";
import { type ClefQuestion, runClef } from "../lib/clef";

/** Agent messages are bounded like the drafting prompt's copy of them. */
const AGENT_MESSAGE_LIMIT = 8_000;

type GateEnv = Parameters<typeof runClef>[0];

/** Pure scoring step: per-check verdicts and the overall status. */
export function scoreReplyDraftGate(
	gate: AgentReplyDeliveryGatePolicy,
	probabilities: Record<string, number>,
): Pick<AgentReplyDeliveryGateResult, "status" | "checks"> {
	const checks = gate.questions.map((question) => {
		const p = probabilities[question.id];
		const pass =
			typeof p === "number" &&
			("gte" in question.autoWhen
				? p >= question.autoWhen.gte
				: p <= question.autoWhen.lte);
		return { id: question.id, p: p ?? 0, pass };
	});
	return {
		status: checks.every((check) => check.pass) ? "pass" : "fail",
		checks,
	};
}

/** The drafter, triage or gate configuration itself. */
const SELF_MODIFICATION =
	/\b(?:drafter|drafting (?:prompt|tedi|policy)|reply[- ]?draft(?:ing)?|(?:turn[- ]?)?triage (?:prompt|policy|questions?)|agent-turn-triage|work\.turn-triage|delivery[- ]?gate|auto[- ]?send)\b/i;
const PUSH = /\bpush(?:ed|es|ing)?\b/i;
const VALIDATION_PASSED =
	/\b(?:pass(?:ed|es|ing)?|green|validated|succeeded)\b/i;

/** A letter, digit or underscore in any script: the edge of a whole word. */
const W = "[\\p{L}\\p{N}_]";
/** Whole words (or `\p{L}*` stems), case-insensitive, in any script. */
const words = (...alternatives: string[]) =>
	new RegExp(`(?<!${W})(?:${alternatives.join("|")})(?!${W})`, "iu");

/** Things whose loss is not undone by git: data, branches, accounts. */
const DESTRUCTIVE_OBJECT = words(
	"branch(?:es)?",
	"tables?",
	"databases?",
	"db",
	"d1",
	"data",
	"datasets?",
	"records?",
	"rows?",
	"columns?",
	"buckets?",
	"backups?",
	"director(?:y|ies)",
	"folders?",
	"worktrees?",
	"repos?",
	"repositor(?:y|ies)",
	"tags?",
	"accounts?",
	"users?",
	"tenants?",
	"organi[sz]ations?",
	"orgs?",
	"namespaces?",
	"kv",
	"r2",
	"queues?",
	"volumes?",
	"customers?",
	"contacts?",
	"emails?",
	"history",
	"ledgers?",
	"zweig\\p{L}*",
	"tabelle\\p{L}*",
	"datenbank\\p{L}*",
	"daten",
	"datens[äa]tz\\p{L}*",
	"ordner\\p{L}*",
	"verzeichnis\\p{L}*",
	"kont(?:o|en)",
	"benutzer\\p{L}*",
	"kund(?:e|en|in|innen)",
	"sicherung\\p{L}*",
	"ramas?",
	"tablas?",
	"base de datos",
	"datos",
	"registros?",
	"filas?",
	"carpetas?",
	"directorios?",
	"cuentas?",
	"usuarios?",
	"clientes?",
	"respaldos?",
	"copias? de seguridad",
);

/** People and public channels a message would reach. */
const RECIPIENT = words(
	"customers?",
	"clients",
	"users",
	"people",
	"person",
	"every(?:one|body)",
	"team",
	"him",
	"her",
	"them",
	"channels?",
	"slack",
	"discord",
	"linkedin",
	"twitter",
	"bluesky",
	"reddit",
	"newsletters?",
	"mailing list",
	"stakeholders?",
	"investors?",
	"vendors?",
	"partners?",
	"suppliers?",
	"colleagues?",
	"coworkers?",
	"candidates?",
	"boss",
	"kund(?:e|en|in|innen)",
	"nutzer\\p{L}*",
	"alle",
	"allen",
	"ihm",
	"ihnen",
	"kanal",
	"kolleg\\p{L}*",
	"lieferant\\p{L}*",
	"clientes?",
	"usuarios?",
	"todos",
	"equipo",
	"él",
	"ella",
	"ellos",
	"canal",
	"colegas?",
	"proveedor\\p{L}*",
	"socios?",
	"jefe",
);

/** Work that belongs to someone other than the asking agent. */
const OTHERS_WORK = words(
	"some(?:one|body) else'?s?",
	"others'?",
	"other\\p{L}*'?s? (?:agents?|sessions?|tedis?|people|persons?|users?|teams?|teammates?|work|items?|runs?|attempts?|tasks?|tickets?|issues?|claims?|leases?|jobs?|branch(?:es)?)",
	"another (?:agent|session|tedi|person|user)'?s?",
	"their",
	"theirs",
	"his",
	"teammates?'?s?",
	"colleagues?'?s?",
	"coworkers?'?s?",
	"not (?:yours|mine|ours)",
	"von (?:anderen|jemand\\p{L}*|kolleg\\p{L}*)",
	"fremd\\p{L}*",
	"ander(?:e|en|er|es) (?:agent\\p{L}*|sitzung\\p{L}*|leute|person\\p{L}*|arbeit)",
	"seine\\p{L}*",
	"de otr[oa]s?",
	"de otra persona",
	"ajen\\p{L}*",
	"de (?:él|ella|ellos)",
	"otr[oa]s? (?:agentes?|sesi[óo]n\\p{L}*|personas?|equipos?)",
);

/**
 * Destructive or externally visible steps, in English, German and Spanish. A
 * class holds when `any` matches the text, or when one sentence holds both a
 * `verb` and an `object` ("delete the old branch" holds, "delete the unused
 * import" does not). Deliberately broad: a false hold costs one review.
 */
const RISK_CLASSES: Array<{
	id: string;
	any?: RegExp;
	verb?: RegExp;
	object?: RegExp;
}> = [
	{
		id: "destructive_delete",
		any: /(?<![\w-])rm\s+-\w*[rf]|git\s+(?:branch\s+-d|push\s+(?:\S+\s+)?(?:--delete|:\S)|clean\s+-\w*f|reset\s+--hard)|\b(?:drop|truncate)\s+(?:table|database|index|column|schema)\b|\bdelete\s+from\b|\bwrangler\s+(?:\S+\s+){0,2}delete\b|(?:delete|remove|rm|wipe|purge|l[öo]sch\p{L}*|entfern\p{L}*|borr\p{L}*|elimin\p{L}*)[^.!?\n]{0,60}(?:~\/|\/users\/|\/home\/|\/etc\/|\/var\/|outside (?:the |this )?repo|au(?:ß|ss)erhalb des repos?|fuera del repo)/iu,
		verb: words(
			"delete[sd]?",
			"deleting",
			"deletion",
			"remov(?:e|es|ed|ing|al)",
			"drop(?:s|ped|ping)?",
			"wip(?:e|es|ed|ing)",
			"purg(?:e|es|ed|ing)",
			"destroy\\p{L}*",
			"eras(?:e|es|ed|ing)",
			"truncat\\p{L}*",
			"nuk(?:e|es|ed|ing)",
			"prun(?:e|es|ed|ing)",
			"l[öo]sch\\p{L}*",
			"gel[öo]scht\\p{L}*",
			"entfern\\p{L}*",
			"vernicht\\p{L}*",
			"borr(?:a|ar|á|e|en|ad[oa]s?)",
			"b[óo]rr(?:alo|ala|alos|alas)",
			"elimin\\p{L}*",
			"suprim\\p{L}*",
			"destru\\p{L}*",
		),
		object: DESTRUCTIVE_OBJECT,
	},
	{
		id: "deploy_or_publish",
		any: /\bwrangler\s+(?:deploy|publish|versions\s+deploy|rollback|secret|d1\s+migrations\s+apply)\b|--remote\b/i,
		verb: words(
			"deploy(?:s|ing)?",
			"redeploy\\p{L}*",
			"hand-deploy\\p{L}*",
			"publish(?:es|ing)?",
			"releas(?:e|es|ing)(?!\\s+(?:the\\s+|its\\s+|my\\s+|your\\s+)?(?:lease|lock|claim|checkout|hold|attempt)s?)",
			"go(?:ing)? live",
			"roll(?:s|ing)? (?:it )?out",
			"rollout",
			"ship(?:s|ping)? (?:it )?to (?:prod\\p{L}*|live|customers|users)",
			"deploye(?:n)?",
			"ausroll\\p{L}*",
			"ver[öo]ffentlich\\p{L}*",
			"live (?:schalten|gehen|stellen)",
			"desplieg\\p{L}*",
			"despleg\\p{L}*",
			"public(?:a|ar|á|ad[oa])",
			"publiqu(?:e|en)",
			"lanz(?:a|ar|á|amiento)",
			"lanc(?:e|en)",
		),
	},
	{
		id: "force_push",
		any: /force[- ]?push\p{L}*|\bpush\p{L}*\s+(?:\S+\s+){0,3}?(?:--force\S*|-f)(?![\w-])|--force-with-lease|--no-verify|push\s+forzad[oa]|forz(?:ar|á|a)\s+(?:el\s+)?push|push\s+erzwing\p{L}*|forcier\p{L}*/iu,
	},
	{
		id: "external_message",
		any: /\b(?:send|email|mail|message|post|reply|write|forward|schick\w*|sende\w*|env[ií]\w*|manda\w*)\b[^.!?\n]{0,80}[\w.+-]+@[\w-]+\.[\w.]+/iu,
		verb: words(
			"send(?:s|ing)?",
			"e-?mail(?:s|ed|ing)?",
			"mail(?:s|ing)?",
			"messag(?:e|es|ing)",
			"post(?:s|ing)?",
			"tweet\\p{L}*",
			"dm",
			"text",
			"repl(?:y|ies) to",
			"respond to",
			"notify(?:ing)?",
			"ping",
			"announc\\p{L}*",
			"forward(?:s|ing)?",
			"invit(?:e|es|ing)",
			"send(?:e|en|et)",
			"schick\\p{L}*",
			"versend\\p{L}*",
			"mail(?:e|en)",
			"benachrichtig\\p{L}*",
			"post(?:e|en)",
			"antwort(?:e|en)",
			"einlad\\p{L}*",
			"env[ií](?:a|ar|á|e|en|alo|ale|ales)",
			"mand(?:a|ar|á|e|en|alo|ale|ales)",
			"notific\\p{L}*",
			"escrib(?:e|ir|í|an)",
			"respond(?:e|er|é|an)",
			"invit(?:a|ar|á)",
			"reenv[ií]\\p{L}*",
		),
		object: RECIPIENT,
	},
	{
		id: "payment_or_credential",
		any: words(
			"pay(?:s|ing|ment|ments|out|outs)?",
			"paid",
			"charge (?:the |a |their )?(?:card|customer|client)",
			"refund\\p{L}*",
			"invoic\\p{L}*",
			"(?:wire|bank) transfer",
			"transfer (?:the )?(?:money|funds)",
			"purchas\\p{L}*",
			"buy(?:ing)?",
			"subscribe to",
			"credit cards?",
			"stripe",
			"credentials?",
			"passwords?",
			"passphrases?",
			"secrets?",
			"api[- ]?keys?",
			"access[- ]?keys?",
			"private[- ]?keys?",
			"ssh[- ]?keys?",
			"(?:access|auth|bearer|refresh) tokens?",
			"vault",
			"2fa",
			"mfa",
			"otp",
			"bezahl\\p{L}*",
			"zahlung\\p{L}*",
			"[üu]berweis\\p{L}*",
			"rechnung\\p{L}*",
			"kauf(?:en|e)",
			"abbuch\\p{L}*",
			"erstatt\\p{L}*",
			"passw[öo]rt\\p{L}*",
			"kennw[öo]rt\\p{L}*",
			"zugangsdaten",
			"geheim\\p{L}*",
			"schl[üu]ssel\\p{L}*",
			"pag(?:ar|a|á|o|os|ue|uen|ado)",
			"cobr\\p{L}*",
			"reembols\\p{L}*",
			"transferencias?",
			"factur\\p{L}*",
			"compr(?:ar|a|á|e|en)",
			"contraseñas?",
			"credencial\\p{L}*",
			"claves?",
			"secretos?",
			"tarjetas?",
		),
	},
	{
		id: "cancel_others_work",
		verb: words(
			"cancel\\p{L}*",
			"clos(?:e|es|ing)",
			"abandon\\p{L}*",
			"discard\\p{L}*",
			"kill(?:s|ing)?",
			"terminat\\p{L}*",
			"reassign\\p{L}*",
			"take over",
			"revert(?:s|ing)?",
			"abbrech\\p{L}*",
			"brich",
			"schlie(?:ß|ss)\\p{L}*",
			"stornier\\p{L}*",
			"verwerf\\p{L}*",
			"beend\\p{L}*",
			"[üu]bernehm\\p{L}*",
			"cerr\\p{L}*",
			"cierr\\p{L}*",
			"descart\\p{L}*",
			"anul\\p{L}*",
			"deten\\p{L}*",
		),
		object: OTHERS_WORK,
	},
];

/** Tooling names that only look risky. */
const BENIGN = /\bscan:secrets\b|\bsecrets?[- ]scan\w*/gi;

/** The risk classes a text names. */
export function replyDraftRiskClasses(text: string): string[] {
	const clean = text.normalize("NFC").replace(BENIGN, " ");
	const sentences = clean.split(/[.!?;\n]+/);
	return RISK_CLASSES.filter(
		(risk) =>
			risk.any?.test(clean) ||
			sentences.some(
				(sentence) =>
					risk.verb?.test(sentence) && risk.object?.test(sentence) !== false,
			),
	).map((risk) => risk.id);
}

/**
 * A negation and the rest of its clause: "workshops can't email customers
 * until reviewed" proposes no step. Not when a pronoun follows, since "can't
 * I delete it?" still asks.
 */
const NEGATED_CLAUSE = new RegExp(
	`(?<!${W})(?:can['’]?t|cannot|can not|won['’]?t|will not|wouldn['’]?t|would not|shouldn['’]?t|should not|mustn['’]?t|must not|don['’]?t|do not|doesn['’]?t|does not|didn['’]?t|did not|no longer|not allowed to|never|nicht|kein\\p{L}*|nie|niemals|no|nunca|jam[áa]s)(?!${W})(?!\\s+(?:i|we|you|ich|wir|du|yo)(?!${W}))[^,;:—–\\n]*`,
	"giu",
);
/** A step only the human user can take: the draft cannot perform it. */
const USER_ASSIGNED = words(
	"your (?:\\p{L}+ ){0,2}(?:part|steps?|clicks?|turn|actions?|job)",
	"you (?:need|have|must|will need) to",
	"you must",
	"you['’]ll need to",
	"when you",
	"only you can",
	"deine? (?:\\p{L}+ ){0,2}(?:teil|schritt\\p{L}*|klicks?)",
	"du musst",
	"wenn du",
	"tu (?:\\p{L}+ ){0,2}(?:parte|pasos?)",
	"tienes que",
	"debes",
	"cuando (?:tú|tu)",
);
/** The agent itself acting: "when you approve, I'll rotate the key". */
const AGENT_SELF = words(
	"i",
	"me",
	"my",
	"we",
	"us",
	"our",
	"ich",
	"mich",
	"wir",
	"yo",
);

/**
 * What the agent asks the user to approve: its questions and closing lines,
 * which is where a bare "yes, go ahead" draft points. Negated clauses and
 * steps assigned to the human user are dropped; the draft is checked whole.
 */
function agentAsk(agentMessage: string): string {
	const questions = agentMessage.match(/[^.!?\n]*\?/g) ?? [];
	return [...questions, agentMessage.slice(-400)]
		.join("\n")
		.normalize("NFC")
		.split(/(?<=[.!?\n])/)
		.filter(
			(sentence) => !USER_ASSIGNED.test(sentence) || AGENT_SELF.test(sentence),
		)
		.map((sentence) => sentence.replace(NEGATED_CLAUSE, " "))
		.join("");
}

/**
 * Deterministic checks no stored policy can relax, failed before any model
 * call: a draft about the drafting or triage prompt, policy or gate itself
 * (self-modification); a push the agent has not reported as validated; and a
 * draft that names, or answers an agent ask about, a destructive or externally
 * visible step ({@link RISK_CLASSES}).
 */
export function guardReplyDraft(
	agentMessage: string,
	draftReply: string,
): AgentReplyDeliveryGateResult["checks"] {
	const checks: AgentReplyDeliveryGateResult["checks"] = [];
	if (
		SELF_MODIFICATION.test(draftReply) ||
		SELF_MODIFICATION.test(agentMessage)
	)
		checks.push({ id: "self_modification", p: 1, pass: false });
	if (
		PUSH.test(draftReply) &&
		(!VALIDATION_PASSED.test(agentMessage) || /\bfail/i.test(agentMessage))
	)
		checks.push({ id: "unvalidated_push", p: 1, pass: false });
	const risks = new Set([
		...replyDraftRiskClasses(draftReply),
		...replyDraftRiskClasses(agentAsk(agentMessage)),
	]);
	for (const id of risks) checks.push({ id, p: 1, pass: false });
	return checks;
}

export async function evaluateReplyDraftGate(
	env: GateEnv,
	params: {
		gate: AgentReplyDeliveryGatePolicy;
		agentMessage: string;
		draftReply: string;
		timeoutMs?: number;
	},
): Promise<AgentReplyDeliveryGateResult> {
	const guarded = guardReplyDraft(params.agentMessage, params.draftReply);
	if (guarded.length)
		return {
			status: "fail",
			model: params.gate.model,
			checks: guarded,
			latencyMs: 0,
		};
	const questions: Record<string, ClefQuestion> = {};
	for (const question of params.gate.questions) {
		questions[question.id] = {
			type: "noul",
			instructions: question.instructions,
		};
	}
	const agentMessage =
		params.agentMessage.length > AGENT_MESSAGE_LIMIT
			? `${params.agentMessage.slice(0, AGENT_MESSAGE_LIMIT)}\n[truncated]`
			: params.agentMessage;
	const result = await runClef(env, {
		modelId: params.gate.model,
		state: { agent_message: agentMessage, draft_reply: params.draftReply },
		questions,
		surface: "agent-reply-delivery-gate",
		timeoutMs: params.timeoutMs,
	});
	if (!result.ok) {
		return {
			status: "unavailable",
			model: params.gate.model,
			checks: [],
			latencyMs: result.latencyMs,
		};
	}
	const probabilities: Record<string, number> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		if (answer.type === "noul") probabilities[id] = answer.noul;
	}
	return {
		...scoreReplyDraftGate(params.gate, probabilities),
		model: params.gate.model,
		latencyMs: result.latencyMs,
	};
}
