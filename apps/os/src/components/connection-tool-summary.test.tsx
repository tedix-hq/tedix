import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ConnectionToolSummary } from "./connection-tool-summary";

const capabilities = [
	{ id: "read", label: "View records", riskTier: "read" as const },
	{
		id: "write",
		label: "Update records",
		riskTier: "bounded_write" as const,
	},
	{
		id: "protected",
		label: "Publish records",
		riskTier: "external_side_effect" as const,
	},
];

describe("connection tool summary", () => {
	it.each(["Notion", "GitHub", "Gmail"])(
		"groups %s tool policy and shows one current safety note",
		(providerName) => {
			const html = renderToStaticMarkup(
				<ConnectionToolSummary
					providerName={providerName}
					capabilities={capabilities}
					complete
				/>,
			);

			expect(html).toContain("What Tedix can do with it");
			expect(html).toContain("Read:");
			expect(html).toContain("Automatic.");
			expect(html).toContain("Create and edit:");
			expect(html).toContain("Automatic, logged.");
			expect(html).toContain("Protected effects:");
			expect(html).toContain("Asks a person first.");
			expect(html).toContain(
				`Tedix keeps your ${providerName} key; your tedis and AI tools never see it. Anything risky waits for a person to approve. Every action is logged.`,
			);
			expect(html.match(/Tedix keeps your/g)).toHaveLength(1);
			expect(html).not.toContain("only what you pick");
			expect(html).not.toContain("checks each person");
		},
	);
});
