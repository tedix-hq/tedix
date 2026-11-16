import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SkillInputsList } from "./skill-inputs-list";

const skill = (inputSchema: Record<string, unknown> | null) => ({
	content: "# Doc",
	files: null,
	inputSchema: inputSchema as never,
});

describe("SkillInputsList", () => {
	it("lists inputs in plain words and keeps names and types under Technical details", () => {
		const html = renderToStaticMarkup(
			<SkillInputsList
				skill={skill({
					type: "object",
					properties: {
						mode: { type: "string", description: "Which report to build" },
						dryRun: { type: "boolean" },
					},
					required: ["mode"],
				})}
			/>,
		);
		const technical = html.indexOf("Technical details");
		expect(technical).toBeGreaterThan(-1);
		const readable = html.slice(0, technical);
		expect(readable).toContain("Mode");
		expect(readable).toContain("Required");
		expect(readable).toContain("Which report to build");
		expect(readable).toContain("Enter: text");
		expect(readable).toContain("Dry run");
		expect(readable).toContain("Optional");
		expect(readable).toContain("Yes or no. No description yet.");
		expect(readable).not.toContain("mode: string");
		expect(readable).not.toContain("dryRun");
		expect(html.slice(technical)).toContain("mode: string · required");
		expect(html.slice(technical)).toContain("dryRun: boolean");
	});

	it("says what can be picked and what is used when a field is left empty", () => {
		const html = renderToStaticMarkup(
			<SkillInputsList
				skill={skill({
					type: "object",
					properties: {
						period: {
							type: "string",
							description: "Reporting period",
							enum: ["last_7_days", "last_30_days"],
						},
						includeRefunds: {
							type: "boolean",
							description: "Count refunded orders",
							default: false,
						},
						limit: { type: "integer", default: 50 },
					},
				})}
			/>,
		);
		expect(html).toContain("One of: last_7_days, last_30_days");
		expect(html).toContain("Enter: yes or no · When left empty: No");
		expect(html).toContain("A number. No description yet.");
		expect(html).toContain("When left empty: 50");
	});

	it("says so when a skill asks for nothing", () => {
		for (const schema of [null, { type: "object", properties: {} }]) {
			const html = renderToStaticMarkup(
				<SkillInputsList skill={skill(schema)} />,
			);
			expect(html).toContain("This skill asks for nothing when it starts.");
			expect(html).not.toContain("Technical details");
		}
	});
});
