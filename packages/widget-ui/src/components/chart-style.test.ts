import { describe, expect, it } from "vite-plus/test";
import { renderChartStyle } from "./chart-style";

describe("renderChartStyle", () => {
	it("keeps supported chart color forms", () => {
		expect(
			renderChartStyle("revenue", {
				gross: { color: "hsl(var(--chart-1))" },
				net: {
					theme: { light: "#2563eb", dark: "var(--chart-2, #60a5fa)" },
				},
			}),
		).toBe(` [data-chart="revenue"] {
  --color-gross: hsl(var(--chart-1));
  --color-net: #2563eb;
}
.dark [data-chart="revenue"] {
  --color-gross: hsl(var(--chart-1));
  --color-net: var(--chart-2, #60a5fa);
}`);
	});

	it("drops keys and values that can escape the declaration", () => {
		const css = renderChartStyle("safe", {
			"gross;} body": { color: "#fff" },
			badColor: { color: "red;} body { display: none" },
			remote: { color: "url(https://attacker.example/pixel)" },
			good: { color: "#0f172a" },
		});

		expect(css).toContain("--color-good: #0f172a;");
		expect(css).not.toContain("body");
		expect(css).not.toContain("attacker");
		expect(css).not.toContain("gross;");
	});

	it("escapes selector ids instead of emitting raw style markup", () => {
		const css = renderChartStyle('x"]{} </style><script>', {
			value: { color: "#fff" },
		});

		expect(css).not.toContain("</style>");
		expect(css).not.toContain("<script>");
		expect(css).toContain("\\22 ");
		expect(css).toContain("\\3c ");
	});
});
