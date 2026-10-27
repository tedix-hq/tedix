import { afterEach, expect, it } from "vite-plus/test";
import { setOsFormattingPreferences } from "@/lib/format";
import { OS_COPY, decisionText } from "./os-copy";

afterEach(() => setOsFormattingPreferences({ locale: null, timezone: null }));

it("follows personal Spanish preferences after the app modules have already loaded", () => {
	expect(OS_COPY.decisionDeck.title).toBe("One decision at a time");
	setOsFormattingPreferences({ locale: "es-MX", timezone: "Europe/Madrid" });
	expect(OS_COPY.decisionDeck.title).toBe("Una decisión a la vez");
	expect(OS_COPY.feed.filters.all).toBe("Para ti");
	expect(OS_COPY.feedDeckVisual.clear).toBe("Todo decidido");
	expect(OS_COPY.workspace.overview).toBe("Resumen");
	expect(OS_COPY.learning.shorter("introducciones")).toContain(
		"textos más breves",
	);
	expect(decisionText("Confirm decision")).toBe("Confirmar decisión");
	setOsFormattingPreferences({ locale: "en-GB", timezone: null });
	expect(OS_COPY.feed.filters.all).toBe("All");
	expect(OS_COPY.workspace.overview).toBe("Overview");
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
		needsLook: "Needs a look",
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
		needsLook: "Necesita revisión",
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
