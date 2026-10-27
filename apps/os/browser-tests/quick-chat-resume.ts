/**
 * The real widget runtime with a Home host whose "server" is localStorage,
 * so a turn started before a reload is still there afterwards: running until
 * its due time, then answered; or failed, when the scenario says so.
 */
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "running";
const RUN_MS = Number(params.get("runMs") ?? 4_000);
const STORE = "quick-chat-resume:runs";
type StoredRun = {
	runId: string;
	conversationId: string;
	text: string;
	dueAt: number;
	status: "running" | "failed";
	answered: boolean;
};
const readRuns = (): StoredRun[] => {
	try {
		return JSON.parse(localStorage.getItem(STORE) ?? "[]") as StoredRun[];
	} catch {
		return [];
	}
};
const writeRuns = (runs: StoredRun[]) =>
	localStorage.setItem(STORE, JSON.stringify(runs));
const runsOf = (conversationId: string) =>
	readRuns().filter((run) => run.conversationId === conversationId);
const answerFor = (run: StoredRun) => `Answered after reload: ${run.text}`;
const wait = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		});
	});
const follow = async (run: StoredRun, signal?: AbortSignal) => {
	await wait(run.dueAt - Date.now(), signal);
	if (run.status === "failed") throw new Error("Home could not answer.");
	writeRuns(
		readRuns().map((item) =>
			item.runId === run.runId ? { ...item, answered: true } : item,
		),
	);
	return { text: answerFor(run) };
};

const script = document.createElement("script");
script.type = "text/plain";
script.dataset.tedixTenant = "demo-resume";
document.head.append(script);
await import("../../widget/src/embed/embed.mjs");
(
	window as unknown as {
		Tedix: { init(options: Record<string, unknown>): void };
	}
).Tedix.init({
	script,
	branding: false,
	locale: "en-US",
	product: "Acme",
	themeMode: params.get("theme") === "dark" ? "dark" : "light",
	preferenceKey: "person-1",
	session: async () => {
		throw Object.assign(new Error("No tedi is available to you here."), {
			code: "tedi_unavailable",
		});
	},
	home: {
		label: "Home",
		turn: async (input: {
			conversationId: string;
			text: string;
			signal?: AbortSignal;
		}) => {
			const run: StoredRun = {
				runId: crypto.randomUUID(),
				conversationId: input.conversationId,
				text: input.text,
				dueAt: Date.now() + RUN_MS,
				// A retry after a failure succeeds, so the failed scenario fails
				// only its first turn.
				status:
					scenario === "failed" && !runsOf(input.conversationId).length
						? "failed"
						: "running",
				answered: false,
			};
			writeRuns([...readRuns(), run]);
			return follow(run, input.signal);
		},
		transcript: async ({ conversationId }: { conversationId: string }) =>
			runsOf(conversationId).flatMap((run) => [
				{ role: "user", content: run.text },
				...(run.answered
					? [{ role: "assistant", content: answerFor(run) }]
					: []),
			]),
		openTurn: async ({ conversationId }: { conversationId: string }) => {
			const latest = runsOf(conversationId).at(-1);
			if (!latest || latest.answered) return null;
			return { runId: latest.runId, status: latest.status };
		},
		resume: async (input: { runId: string; signal?: AbortSignal }) => {
			const run = readRuns().find((item) => item.runId === input.runId);
			if (!run) throw new Error("Unknown run");
			return follow(run, input.signal);
		},
	},
});
