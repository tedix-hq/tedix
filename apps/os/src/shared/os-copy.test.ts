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
	expect(OS_COPY.learning.shorter("introducciones")).toContain(
		"textos más breves",
	);
	expect(decisionText("Confirm decision")).toBe("Confirmar decisión");
	setOsFormattingPreferences({ locale: "en-GB", timezone: null });
	expect(OS_COPY.feed.filters.all).toBe("For you");
	expect(decisionText("Confirm decision")).toBe("Confirm decision");
});
