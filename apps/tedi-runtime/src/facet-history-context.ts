/** First-turn migration history; the facet owns subsequent conversation context. */
export interface FacetHistoryInput {
	priorTurnCount: number;
	sessionKey: string;
	text: string;
	userTs: number;
	runId: string;
}

export interface FacetHistoryReport {
	event: "tedi.context.history";
	runId: string;
	status: "facet_history_owned" | "empty" | "hydrated" | "read_failed";
	sourceMessages: number | null;
	sourceCharacters: number | null;
	retainedCharacters: number;
	droppedCharacters: number | null;
	capCharacters: number;
	durationMs: number;
}

export async function hydrateFacetHistory(
	input: FacetHistoryInput,
	readHistory: () => Promise<Array<{ role: string; content: unknown }>>,
	capCharacters: number,
	emit: (report: FacetHistoryReport) => void = (report) => console.log(report),
): Promise<string> {
	const started = performance.now();
	const report: FacetHistoryReport = {
		event: "tedi.context.history",
		runId: input.runId,
		status: "facet_history_owned",
		sourceMessages: null,
		sourceCharacters: null,
		retainedCharacters: 0,
		droppedCharacters: null,
		capCharacters,
		durationMs: 0,
	};
	try {
		if (input.priorTurnCount !== 0) return input.text;
		const prior = await readHistory();
		report.sourceMessages = prior.length;
		report.sourceCharacters = 0;
		report.droppedCharacters = 0;
		report.status = "empty";
		if (prior.length === 0) return input.text;
		const rendered = prior
			.map((message) =>
				typeof message.content === "string"
					? `${message.role}: ${message.content}`
					: "",
			)
			.filter(Boolean)
			.join("\n");
		const retained = rendered.slice(-capCharacters);
		report.sourceCharacters = rendered.length;
		report.retainedCharacters = retained.length;
		report.droppedCharacters = rendered.length - retained.length;
		report.status = "hydrated";
		return `Prior turns in this conversation (context only):\n${retained}\n\n---\n\n${input.text}`;
	} catch {
		report.status = "read_failed";
		return input.text;
	} finally {
		report.durationMs = Math.round(performance.now() - started);
		try {
			emit(report);
		} catch {
			/* Observability is not a context dependency. */
		}
	}
}
