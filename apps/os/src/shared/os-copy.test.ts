import { afterEach, expect, it } from "vite-plus/test";
import { ATTENTION_COPY } from "@tedix/api-contract/utils/attention-copy";
import { setOsFormattingPreferences } from "@/lib/format";
import { WORK_VIEW_GROUPS, WORK_VIEWS } from "@/lib/work-views";
import { OS_COPY, decisionText } from "./os-copy";

afterEach(() => setOsFormattingPreferences({ locale: null, timezone: null }));

function visibleStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object") return [];
	return Object.values(value).flatMap(visibleStrings);
}

// The visible word is Goal, by the owner's decision of 15 Nov 2026. The API
// name `objective` is unchanged: keys, routes and field names keep it, labels
// never show it. Do not switch this copy back to Objective.
it("says Goal, never Objective, in visible Work copy", () => {
	const workCopy = () => [
		...visibleStrings(OS_COPY.work),
		...visibleStrings(OS_COPY.workHome),
		...visibleStrings(OS_COPY.navigation),
		...WORK_VIEW_GROUPS.map((group) => group.label),
		...WORK_VIEWS.flatMap((view) => [view.label, view.description]),
	];
	const english = [...workCopy(), ...visibleStrings(ATTENTION_COPY)];
	expect(english.filter((text) => /\bobjectives?\b/i.test(text))).toEqual([]);
	expect(OS_COPY.work.objective).toBe("Goal");
	expect(OS_COPY.work.objectives).toBe("Goals");
	expect(ATTENTION_COPY.goal).toBe("Goal");
	expect(ATTENTION_COPY.goals).toBe("Goals");
	expect(WORK_VIEWS.find((view) => view.id === "goals")).toMatchObject({
		label: "Goals",
		description: "Every goal and the projects and epics serving it.",
	});

	setOsFormattingPreferences({ locale: "es-MX", timezone: null });
	expect(workCopy().filter((text) => /\bobjetivos?\b/i.test(text))).toEqual([]);
	expect(OS_COPY.work.objective).toBe("Meta");
	expect(OS_COPY.work.objectives).toBe("Metas");
	expect(WORK_VIEWS.find((view) => view.id === "goals")?.label).toBe("Metas");
});

it("follows personal Spanish preferences after the app modules have already loaded", () => {
	expect(OS_COPY.decisionDeck.title).toBe("One decision at a time");
	setOsFormattingPreferences({ locale: "es-MX", timezone: "Europe/Madrid" });
	expect(OS_COPY.decisionDeck.title).toBe("Una decisión a la vez");
	expect(OS_COPY.feed.filters.all).toBe("Para ti");
	expect(OS_COPY.feedDeckVisual.clear).toBe("Todo decidido");
	expect(OS_COPY.workspace.overview).toBe("Resumen");
	expect(OS_COPY.work.status).toBe("Estado");
	expect(OS_COPY.work.objective).toBe("Meta");
	expect(OS_COPY.work.objectives).toBe("Metas");
	expect(OS_COPY.work.dispositions).toEqual({
		proposed: "Propuesto",
		accepted: "Aceptado",
		completed: "Completado",
		cancelled: "Cancelado",
	});
	expect(OS_COPY.decisionDeck.cardKinds.question).toBe("Solicitud");
	expect(OS_COPY.feed.filters.attention).toBe(
		OS_COPY.feed.timeline.status.needsYou,
	);
	expect(OS_COPY.learning.shorter("introducciones")).toContain(
		"textos más breves",
	);
	expect(decisionText("Confirm decision")).toBe("Confirmar decisión");
	setOsFormattingPreferences({ locale: "en-GB", timezone: null });
	expect(OS_COPY.feed.filters.all).toBe("All");
	expect(OS_COPY.workspace.overview).toBe("Overview");
	expect(OS_COPY.work.dispositions.accepted).toBe("Accepted");
	expect(OS_COPY.work.status).toBe("Status");
	expect(OS_COPY.work.objective).toBe("Goal");
	expect(OS_COPY.work.objectives).toBe("Goals");
	expect(decisionText("Confirm decision")).toBe("Confirm decision");
});

it("switches the Activity timeline labels between English and Spanish", () => {
	expect(OS_COPY.feed.timeline.who).toEqual({
		all: "All",
		people: "People",
		tedis: "Tedis",
		apps: "Apps",
		shipped: "Shipped",
	});
	expect(OS_COPY.feed.timeline.today).toBe("Today");
	expect(OS_COPY.feed.timeline.yesterday).toBe("Yesterday");
	expect(OS_COPY.feed.timeline.status).toEqual({
		finished: "Finished",
		unfinished: "Didn't finish",
		partial: "Partly done",
		paused: "Paused",
		stopped: "Stopped",
		needsLook: "Needs you",
		needsYou: "Needs you",
	});
	expect(OS_COPY.feed.timeline.more).toBe("More");
	expect(OS_COPY.feed.timeline.less).toBe("Less");
	expect(OS_COPY.feed.timeline.groupSummary("Codex", 4)).toBe(
		"Codex posted 4 similar updates",
	);
	expect(OS_COPY.feed.timeline.groupLabel(4, "Codex")).toBe(
		"4 updates from Codex",
	);
	expect(OS_COPY.feed.timeline.showAll(4)).toBe("Show all 4");
	expect(OS_COPY.feed.showLess).toBe("Show less");
	expect(OS_COPY.feed.timeline.whoGroup).toBe("Show activity from");
	expect(OS_COPY.feed.timeline.whoRegion("People")).toBe("People activity");
	expect(OS_COPY.feed.timeline.forYou).toBe("Activity for you");
	expect(OS_COPY.feed.timeline.showAllActivity).toBe("Show all activity");
	expect(OS_COPY.feed.timeline.nothingNew).toBe(
		"Nothing new needs your attention.",
	);
	expect(OS_COPY.feed.timeline.empty).toBe("No activity yet.");
	expect(OS_COPY.feed.timeline.noMatch).toBe(
		"No activity matches these filters.",
	);
	expect(OS_COPY.feed.timeline.hint).toContain("Shipped");

	setOsFormattingPreferences({ locale: "es-MX", timezone: null });
	expect(OS_COPY.feed.timeline.who).toEqual({
		all: "Todo",
		people: "Personas",
		tedis: "Tedis",
		apps: "Apps",
		shipped: "Entregado",
	});
	expect(OS_COPY.feed.timeline.today).toBe("Hoy");
	expect(OS_COPY.feed.timeline.yesterday).toBe("Ayer");
	expect(OS_COPY.feed.timeline.status).toEqual({
		finished: "Terminado",
		unfinished: "No terminó",
		partial: "Hecho en parte",
		paused: "En pausa",
		stopped: "Detenido",
		needsLook: "Necesita tu atención",
		needsYou: "Necesita tu atención",
	});
	expect(OS_COPY.feed.timeline.more).toBe("Más");
	expect(OS_COPY.feed.timeline.less).toBe("Menos");
	expect(OS_COPY.feed.timeline.groupSummary("Codex", 4)).toBe(
		"Codex publicó 4 actualizaciones similares",
	);
	expect(OS_COPY.feed.timeline.groupLabel(4, "Codex")).toBe(
		"4 actualizaciones de Codex",
	);
	expect(OS_COPY.feed.timeline.showAll(4)).toBe("Mostrar las 4");
	expect(OS_COPY.feed.showLess).toBe("Mostrar menos");
	expect(OS_COPY.feed.timeline.whoGroup).toBe("Mostrar actividad de");
	expect(OS_COPY.feed.timeline.whoRegion("Personas")).toBe(
		"Actividad: Personas",
	);
	expect(OS_COPY.feed.timeline.forYou).toBe("Actividad para ti");
	expect(OS_COPY.feed.timeline.showAllActivity).toBe(
		"Mostrar toda la actividad",
	);
	expect(OS_COPY.feed.timeline.nothingNew).toBe(
		"Nada nuevo necesita tu atención.",
	);
	expect(OS_COPY.feed.timeline.empty).toBe("Todavía no hay actividad.");
	expect(OS_COPY.feed.timeline.noMatch).toBe(
		"Ninguna actividad coincide con estos filtros.",
	);
	expect(OS_COPY.feed.timeline.hint).toContain("Entregado");
});
