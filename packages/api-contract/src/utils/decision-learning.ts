import { lessonMatches } from "@tedix/context-core/situational-recall";
import type { LearningInteractionEvent } from "../schemas/learning-feedback";
import {
	DecisionLearningConfigSchema,
	type DecisionLearningConfig,
	type DecisionLearningModel,
	type LearnedWeight,
	type LearningLesson,
} from "../schemas/decision-learning";

const str = (value: unknown): string =>
	typeof value === "string" ? value : "";
const rec = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
export function learningClass(event: LearningInteractionEvent) {
	const m = event.metadata ?? {};
	return (
		str(m.decisionClass) ||
		str(m.classId) ||
		str(rec(m.scope).topic) ||
		event.issueKey ||
		event.targetType ||
		event.surface
	);
}
function learningSource(source: string) {
	if (source.startsWith("/")) return source.split("/").slice(0, 3).join("/");
	try {
		return new URL(source).origin;
	} catch {
		return source;
	}
}
function hour(at: string, timezone: string) {
	return Number(
		new Intl.DateTimeFormat("en", {
			hour: "numeric",
			hourCycle: "h23",
			timeZone: timezone,
		}).format(new Date(at)),
	);
}
function strength(
	event: LearningInteractionEvent,
	config: DecisionLearningConfig,
) {
	const m = event.metadata ?? {};
	if (m.outcome === "completed_late" || m.outcome === "reverted") return -1;
	if (m.decisionChoice === "later" || m.reaction === "skip") return -0.35;
	if (event.eventKind === "ignored") return -config.ignoredPenalty;
	if (m.reaction === "why") return 0.1;
	if (m.reaction === "work") return 1.5;
	if (
		["rejected", "undone", "ignored", "manually_replaced"].includes(
			event.eventKind,
		)
	)
		return -1;
	if (
		event.eventKind === "accepted" ||
		m.outcome === "replied" ||
		m.outcome === "completed_on_time"
	) {
		return typeof m.elapsedMs === "number" &&
			m.elapsedMs <= config.fastDecisionMs
			? 1.5
			: 1;
	}
	if (event.eventKind === "edited" || m.reaction === "comment") return 0.25;
	if (m.decisionChoice === "delegate") return 0.5;
	return event.eventKind === "answered" ? 0.15 : 0;
}

/** Replay exactly the caller-visible ledger. Personal signals never cross people/orgs. */
export function learnDecisions(input: {
	organizationId: string;
	personId: string | null;
	events: readonly LearningInteractionEvent[];
	config?: DecisionLearningConfig;
	now: Date;
	lessons?: LearningLesson[];
}): DecisionLearningModel {
	const config = DecisionLearningConfigSchema.parse(input.config ?? {});
	const visible = [
		...new Map(
			input.events
				.filter(
					(e) =>
						e.organizationId === input.organizationId &&
						(e.scopeKind !== "personal" ||
							(input.personId !== null && e.scopeId === input.personId)) &&
						Number.isFinite(Date.parse(e.occurredAt)) &&
						Date.parse(e.occurredAt) <= input.now.getTime(),
				)
				.map((e) => [e.id, e]),
		).values(),
	].sort(
		(a, b) =>
			a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
	);
	const byId = new Map(visible.map((e) => [e.id, e]));
	// Only the same actor can retract its own evidence. Corrections are append-only.
	const corrected = new Set(
		visible
			.filter(
				(e) =>
					e.eventKind === "undone" && e.metadata?.learningCorrection === true,
			)
			.flatMap((e) => {
				const id = str(e.metadata?.correctsEventId);
				const original = byId.get(id);
				return original &&
					original.actorId === e.actorId &&
					original.scopeKind === e.scopeKind &&
					original.scopeId === e.scopeId
					? [id]
					: [];
			}),
	);
	const events = visible
		.filter(
			(e) =>
				!corrected.has(e.id) &&
				!corrected.has(str(e.metadata?.preferenceEvidenceEventId)) &&
				e.metadata?.learningCorrection !== true,
		)
		.slice(-config.historyLimit);
	const maps = {
		personal: new Map<string, LearnedWeight>(),
		organization: new Map<string, LearnedWeight>(),
		time: new Map<string, LearnedWeight>(),
		urgency: new Map<string, LearnedWeight>(),
		priority: new Map<string, LearnedWeight>(),
		usefulness: new Map<string, LearnedWeight>(),
	};
	const readiness = new Map<
		string,
		DecisionLearningModel["readiness"][number]
	>();
	const edits = new Map<
		string,
		{ ids: string[]; sizes: number[]; sentences: string[] }
	>();
	function add(
		dimension: keyof typeof maps,
		key: string,
		value: number,
		id: string,
	) {
		if (!key) return;
		const old = maps[dimension].get(key) ?? {
			key,
			value: 0,
			examples: 0,
			evidenceIds: [],
		};
		old.value += value;
		old.examples++;
		old.evidenceIds = [...old.evidenceIds, id].slice(-10);
		maps[dimension].set(key, old);
	}
	for (const e of events) {
		const m = e.metadata ?? {};
		const classId = learningClass(e);
		if (m.preferenceSource === "classifier") {
			const parent = byId.get(str(m.preferenceEvidenceEventId));
			if (
				parent &&
				parent.actorId === e.actorId &&
				parent.scopeId === e.scopeId &&
				typeof m.preferenceSentence === "string"
			) {
				const entry = edits.get(classId) ?? {
					ids: [],
					sizes: [],
					sentences: [],
				};
				entry.ids.push(parent.id);
				entry.sentences.push(m.preferenceSentence.slice(0, 400));
				edits.set(classId, entry);
			}
			continue;
		}
		const decay = Math.pow(
			0.5,
			(input.now.getTime() - Date.parse(e.occurredAt)) /
				(86400000 * config.halfLifeDays),
		);
		const value = strength(e, config) * decay;
		const dimension = e.scopeKind === "personal" ? "personal" : "organization";
		add(dimension, `class:${classId}`, value, e.id);
		for (const [key, id] of [
			["person", m.personId],
			["channel", m.channel],
			["entity", m.entityId],
		] as const)
			if (typeof id === "string") add(dimension, `${key}:${id}`, value, e.id);
		const projectId =
			str(m.projectId) || (e.scopeKind === "project" ? e.scopeId : "");
		if (projectId) add("priority", `project:${projectId}`, value, e.id);
		if (m.urgency === "now") add("urgency", `class:${classId}`, value, e.id);
		add("time", `hour:${hour(e.occurredAt, config.timezone)}`, value, e.id);
		add(
			"time",
			`hour:${hour(e.occurredAt, config.timezone)}:class:${classId}`,
			value,
			e.id,
		);
		for (const key of [
			`class:${classId}`,
			e.tediId || str(m.proposerTediId)
				? `tedi:${e.tediId || str(m.proposerTediId)}`
				: "",
			str(m.source) ? `source:${learningSource(str(m.source))}` : "",
		])
			add("usefulness", key, value, e.id);
		// Personal readiness counts only explicit, unchanged human approvals.
		if (
			e.scopeKind === "personal" &&
			e.scopeId === input.personId &&
			e.actorType === "user"
		) {
			const state = readiness.get(classId) ?? {
				classId,
				unchanged: 0,
				ready: false,
				evidenceIds: [],
			};
			if (
				e.eventKind === "accepted" &&
				m.serverObserved === true &&
				m.feedbackSignal === "approve-as-is" &&
				m.decisionChoice === "approve"
			) {
				if (state.unchanged === 0) state.evidenceIds = [];
				state.unchanged++;
				state.evidenceIds.push(e.id);
			} else if (
				["rejected", "edited", "undone", "manually_replaced"].includes(
					e.eventKind,
				)
			) {
				state.unchanged = 0;
				state.evidenceIds = [e.id];
			}
			state.ready =
				config.enabled && state.unchanged >= config.unchangedThreshold;
			state.evidenceIds = state.evidenceIds.slice(-100);
			readiness.set(classId, state);
		}
		if (
			e.scopeKind === "personal" &&
			["edited", "manually_replaced"].includes(e.eventKind)
		) {
			const before =
				str(m.originalBody) || str(m.before) || str(rec(m.draft).body);
			const after = str(m.editedBody) || str(m.after) || str(m.answer);
			const entry = edits.get(classId) ?? { ids: [], sizes: [], sentences: [] };
			if (
				before &&
				after &&
				(typeof m.editedLength === "number" ? m.editedLength : after.length) <
					(typeof m.originalLength === "number"
						? m.originalLength
						: before.length) *
						config.shorteningRatio
			) {
				entry.ids.push(e.id);
				entry.sizes.push(
					typeof m.editedLength === "number" && m.editedLength > 0
						? m.editedLength
						: after.length,
				);
			}
			edits.set(classId, entry);
		}
	}
	const weights = Object.fromEntries(
		Object.entries(maps).map(([key, map]) => [
			key,
			[...map.values()].map((w) => ({
				...w,
				value: Math.tanh(w.value / Math.sqrt(Math.max(1, w.examples))),
			})),
		]),
	) as DecisionLearningModel["weights"];
	return {
		config,
		asOf: input.now.toISOString(),
		weights,
		eventCount: events.length,
		receipts: events
			.filter(
				(e) =>
					e.scopeKind === "personal" &&
					e.actorId === input.personId &&
					e.metadata?.preferenceSource !== "classifier",
			)
			.slice(-20)
			.reverse()
			.map((e) => {
				const m = e.metadata ?? {};
				const before = str(m.originalBody) || str(m.before);
				const after = str(m.editedBody) || str(m.after);
				return {
					eventId: e.id,
					classId: learningClass(e),
					eventKind: e.eventKind,
					choice: str(m.decisionChoice) || str(m.reaction),
					shortened:
						!!before &&
						!!after &&
						(typeof m.editedLength === "number"
							? m.editedLength
							: after.length) <
							(typeof m.originalLength === "number"
								? m.originalLength
								: before.length) *
								config.shorteningRatio,
				};
			}),
		lessons: input.lessons ?? [],
		readiness: [...readiness.values()],
		preferences: [...edits].flatMap(([classId, e]) =>
			new Set(e.ids).size >= config.minimumPreferenceExamples
				? [
						{
							classId,
							sentence:
								e.sentences.at(-1) ?? `Use shorter wording for ${classId}.`,
							evidenceIds: [...new Set(e.ids)].slice(-10),
							maxCharacters: e.sizes.length
								? Math.max(
										1,
										Math.round(
											e.sizes.reduce((a, b) => a + b, 0) / e.sizes.length,
										),
									)
								: null,
						},
					]
				: [],
		),
	};
}

export interface LearningCandidate {
	id: string;
	classId: string;
	projectId?: string | null;
	tediId?: string | null;
	source?: string;
	text?: string;
	personIds?: string[];
	channel?: string;
	entityIds?: string[];
	dueAt?: string | null;
	urgency?: number;
	costOfWaiting?: number;
	protected?: boolean;
	lessons?: LearningLesson[];
}
export function scoreLearning(
	candidate: LearningCandidate,
	model: DecisionLearningModel,
	now: Date,
) {
	const factors: Array<{
		level: string;
		contribution: number;
		evidenceIds: string[];
		reason: string;
	}> = [];
	if (!model.config.enabled)
		return { score: 0, factors, lessonIds: [] as string[] };
	const keys = new Set([
		`class:${candidate.classId}`,
		`project:${candidate.projectId}`,
		`tedi:${candidate.tediId}`,
		`source:${learningSource(candidate.source ?? "")}`,
		`hour:${hour(now.toISOString(), model.config.timezone)}`,
		`hour:${hour(now.toISOString(), model.config.timezone)}:class:${candidate.classId}`,
		`channel:${candidate.channel}`,
		...(candidate.personIds ?? []).map((id) => `person:${id}`),
		...(candidate.entityIds ?? []).map((id) => `entity:${id}`),
	]);
	for (const level of [
		"personal",
		"organization",
		"time",
		"priority",
		"usefulness",
	] as const) {
		const matches = model.weights[level].filter((w) => keys.has(w.key));
		for (const w of matches)
			factors.push({
				level,
				contribution: w.value * model.config.weights[level],
				evidenceIds: w.evidenceIds,
				reason: `${w.examples} ${level === "personal" ? "of your past choices" : level === "priority" ? "project responses" : level === "time" ? "choices around this time of day" : level === "organization" ? "team signals" : "usefulness signals"}${w.key.startsWith("class:") ? ` about ${candidate.classId.replaceAll(/[-_:]/g, " ")}` : ""}`,
			});
	}
	if (candidate.urgency)
		for (const weight of model.weights.urgency.filter(
			(w) => w.key === `class:${candidate.classId}`,
		))
			factors.push({
				level: "urgency",
				contribution: weight.value * model.config.weights.urgencyLearning,
				evidenceIds: weight.evidenceIds,
				reason: "How you handled earlier urgent suggestions of this kind",
			});
	const due = candidate.dueAt ? Date.parse(candidate.dueAt) : NaN;
	const deadline = Number.isFinite(due)
		? Math.max(
				0,
				Math.min(
					2,
					1 -
						(due - now.getTime()) /
							(model.config.deadlineWindowHours * 3600000),
				),
			)
		: 0;
	const urgency = Math.max(
		deadline,
		Math.min(2, Math.max(0, candidate.urgency ?? 0)),
		Math.min(2, Math.max(0, candidate.costOfWaiting ?? 0)),
	);
	if (urgency)
		factors.push({
			level: "urgency",
			contribution: urgency * model.config.weights.urgency,
			evidenceIds: [],
			reason: deadline
				? `Deadline ${candidate.dueAt}; cost of waiting rises as it approaches`
				: "Recorded urgency and cost of waiting",
		});
	const q = model.config.quietHours;
	const h = hour(now.toISOString(), model.config.timezone);
	if (
		q &&
		(q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end) &&
		!candidate.protected &&
		urgency < 1
	)
		factors.push({
			level: "time",
			contribution: -model.config.weights.time,
			evidenceIds: [],
			reason: "Configured quiet hours",
		});
	const lessons = [
		...new Map(
			[...model.lessons, ...(candidate.lessons ?? [])].map((l) => [l.id, l]),
		).values(),
	].filter(
		(l) =>
			l.classId === candidate.classId ||
			lessonMatches(l.triggers, {
				text: `${candidate.classId} ${candidate.text ?? ""}`,
			}),
	);
	for (const lesson of lessons)
		factors.push({
			level: "organization",
			contribution: model.config.weights.organization,
			evidenceIds: [lesson.id],
			reason: `Applicable lesson: ${lesson.text.slice(0, 240)}`,
		});
	return {
		score: factors.reduce((sum, f) => sum + f.contribution, 0),
		factors,
		lessonIds: [...new Set(lessons.map((l) => l.id))],
	};
}

/** Stable sampling, so a refresh cannot evade an audit. This does not execute anything. */
export function learningAutoReadiness(
	candidate: LearningCandidate,
	model: DecisionLearningModel,
) {
	const state = model.readiness.find((r) => r.classId === candidate.classId);
	let hash = 2166136261;
	for (const c of candidate.id)
		hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
	const sampled = hash / 4294967296 < model.config.auditSampleRate;
	return {
		ready:
			!!state?.ready &&
			model.config.enabled &&
			!candidate.protected &&
			!sampled,
		sampled,
		unchanged: state?.unchanged ?? 0,
		evidenceIds: state?.evidenceIds ?? [],
	};
}
export function draftLearningContext(
	model: DecisionLearningModel,
	classId?: string,
) {
	if (!model.config.enabled) return "";
	const prefs = model.preferences.filter(
		(p) => !classId || p.classId === classId,
	);
	const lessons = model.lessons.filter(
		(l) => !classId || l.classId === null || l.classId === classId,
	);
	if (!prefs.length && !lessons.length) return "";
	return JSON.stringify({
		purpose:
			"Learned writing preferences; context only. Preserve facts, recipients, consent and authority.",
		preferences: prefs,
		lessons,
	});
}
