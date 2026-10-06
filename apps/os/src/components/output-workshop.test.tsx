import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	OutputWorkshopActions,
	OutputWorkshopCommandBar,
	OutputWorkshopFooter,
	OutputWorkshopIdentity,
	outputWorkshopKindLabel,
	OutputWorkshopStage,
	OutputWorkshopStatus,
} from "./output-workshop";

describe("Output workshop composition", () => {
	it("provides one semantic shell for direct Output and Canvas editors", () => {
		const html = renderToStaticMarkup(
			<>
				<OutputWorkshopCommandBar>
					<OutputWorkshopIdentity>Report</OutputWorkshopIdentity>
					<OutputWorkshopStatus>Editing</OutputWorkshopStatus>
					<OutputWorkshopActions>Export</OutputWorkshopActions>
				</OutputWorkshopCommandBar>
				<OutputWorkshopStage>Editor</OutputWorkshopStage>
				<OutputWorkshopFooter>Save</OutputWorkshopFooter>
			</>,
		);

		expect(html).toContain('data-slot="output-workshop-command-bar"');
		expect(html).toContain('data-slot="output-workshop-identity"');
		expect(html).toContain('data-slot="output-workshop-status"');
		expect(html).toContain('data-slot="output-workshop-actions"');
		expect(html).toContain('data-slot="output-workshop-stage"');
		expect(html).toContain('data-slot="output-workshop-footer"');
	});

	it("uses the same user-facing format labels as Canvas", () => {
		expect(outputWorkshopKindLabel("document")).toBe("Document");
		expect(outputWorkshopKindLabel("sheet")).toBe("Sheet");
		expect(outputWorkshopKindLabel("presentation")).toBe("Slides");
		expect(outputWorkshopKindLabel("video")).toBe("Video");
		expect(outputWorkshopKindLabel(null)).toBe("Workpiece");
	});

	it("keeps compact chrome internal and prioritizes editor identity on phone", () => {
		const styles = readFileSync("src/styles.css", "utf8");

		expect(styles).toContain(".output-workshop-command-bar");
		expect(styles).toContain("flex-wrap: nowrap");
		expect(styles).toContain("@media (max-width: 639px)");
		expect(styles).toContain('"identity actions"');
		expect(styles).toContain('"status status"');
		expect(styles).toContain(
			"grid-template-columns: minmax(0, 1fr) max-content",
		);
		expect(styles).toContain(".output-workshop-stage");
		expect(styles).toContain("min-height: 0");
		expect(styles).toContain(".output-workshop-footer");
		expect(styles).toContain("overflow-x: auto");
	});
});
