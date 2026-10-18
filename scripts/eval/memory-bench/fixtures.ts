/** Deterministic, fictional corpus. Expected IDs never enter retrieval inputs. */
export const NOW = "2026-10-18T12:00:00.000Z";
export const orgs = ["org_fable_aster", "org_fable_birch", "org_fable_coral"];
export interface Fact {
	id: string;
	org: string;
	content: string;
	validTo?: string;
	metadata?: Record<string, unknown>;
	topicKey?: string;
	confidence?: number;
	entity?: string;
	date?: string;
}
export interface Query {
	id: string;
	org: string;
	text: string;
	expected: string[];
	forbidden: string[];
	kind: string;
}
export const facts: Fact[] = orgs.flatMap((org, o) =>
	Array.from({ length: 10 }, (_, i) => {
		const entity = `Vessel-${i}`;
		const stem = `${o}-${i}`;
		return [
			{
				id: `${stem}-captain`,
				org,
				entity,
				content: `${entity} captain is Mira-${o}-${i}. Mira-${o}-${i} leads the Amber-${i} expedition.`,
			},
			{
				id: `${stem}-old`,
				org,
				entity,
				content: `${entity} launch was 2026-02-${String(i + 1).padStart(2, "0")} from Quartz Dock.`,
				validTo: "2026-03-01T00:00:00Z",
			},
			{
				id: `${stem}-launch`,
				org,
				entity,
				date: `2026-04-${String(i + 1).padStart(2, "0")}`,
				content: `${entity} launch is now 2026-04-${String(i + 1).padStart(2, "0")} from Opal Dock, replacing the February plan.`,
			},
			{
				id: `${stem}-cargo`,
				org,
				entity,
				content: `Amber-${i} expedition carries ${["violet seeds", "copper bells", "paper cranes"][o]} to the moon Lumen-${i}.`,
			},
		];
	}).flat(),
);
export const queries: Query[] = Array.from({ length: 40 }, (_, n) => {
	const o = n % 3,
		i = Math.floor(n / 3) % 10,
		stem = `${o}-${i}`,
		kind = ["entity", "temporal", "supersession", "entity-hop"][n % 4]!;
	return {
		id: `recall-${n}`,
		org: orgs[o]!,
		kind,
		text:
			kind === "entity"
				? `Who is Vessel-${i} captain?`
				: kind === "temporal"
					? `Which launch is scheduled for 2026-04-${String(i + 1).padStart(2, "0")} at Opal Dock?`
					: kind === "supersession"
						? `Vessel-${i} launch current replacement date dock`
						: `What cargo does the expedition led by Mira-${o}-${i} carry?`,
		expected: [
			`${stem}-${kind === "entity" ? "captain" : kind === "entity-hop" ? "cargo" : "launch"}`,
		],
		forbidden: [
			`${stem}-old`,
			...facts.filter((f) => f.org !== orgs[o]).map((f) => f.id),
		],
	};
});
export const corrections = Array.from({ length: 30 }, (_, i) => ({
	id: `lesson-${String(i).padStart(3, "0")}`,
	sourceId: `source-${i}`,
	org: orgs[i % 3]!,
	correction: `For Lantern-${i}, do not use the old route; use violet-channel-${i}.`,
	lesson: `Lantern-${i} releases require violet-channel-${i} and a signed receipt.`,
	prompt: `Prepare Lantern-${i} release with violet-channel-${i}.`,
}));
export const lessonPrompts = corrections
	.slice(0, 20)
	.map((c) => ({ text: c.prompt, org: c.org, expected: [c.id] }));
export const invalidSources = corrections
	.filter((_, i) => [0, 4, 8, 9, 13, 17, 18, 22, 26, 27].includes(i))
	.map((c) => c.sourceId);
/** LongMemEval record fields; synthetic content, retrieval scoring only (no answer judge). */
export const longMemEval = Array.from({ length: 50 }, (_, i) => {
	const category = [
		"single-session-user",
		"single-session-assistant",
		"multi-session",
		"temporal-reasoning",
		"knowledge-update",
	][i % 5]!;
	const entity = `Beacon-${i}`,
		org = orgs[i % 3]!;
	const messages = [
		`I assigned ${entity} to Neri-${i}.`,
		`${entity} inspection moved from May 2 to June ${(i % 20) + 1}, 2026.`,
		`Neri-${i} stores ${entity} permits in the lilac vault.`,
	];
	return {
		question_id: `synthetic-lme-${i}`,
		question_type: category,
		org,
		question:
			category === "multi-session"
				? `Where does the person assigned ${entity} store its permits?`
				: category === "single-session-user"
					? `Who is assigned ${entity}?`
					: category === "single-session-assistant"
						? `Where are ${entity} permits stored?`
						: `What is the updated inspection date for ${entity}?`,
		answer:
			category === "multi-session" || category === "single-session-assistant"
				? "lilac vault"
				: category === "single-session-user"
					? `Neri-${i}`
					: `June ${(i % 20) + 1}, 2026`,
		question_date: "2026/10/18 (Sun) 12:00",
		haystack_dates: [
			"2026/04/01 (Wed) 12:00",
			"2026/05/01 (Fri) 12:00",
			"2026/06/01 (Mon) 12:00",
		],
		haystack_session_ids: messages.map((_, j) => `lme-${i}-${j}`),
		haystack_sessions: messages.map((content) => [
			{ role: "user", content },
			{ role: "assistant", content: "Recorded the fictional update." },
		]),
		answer_session_ids: [
			`lme-${i}-${category === "multi-session" || category === "single-session-assistant" ? 2 : category === "single-session-user" ? 0 : 1}`,
		],
	};
});
