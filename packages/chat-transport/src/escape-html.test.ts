import { describe, expect, it } from "vite-plus/test";
import { escapeHtml } from "./escape-html";

describe("escapeHtml", () => {
	it("escapes every HTML-significant character and keeps the rest", () => {
		expect(escapeHtml(`<script>alert("x&y")</script> 'q'`)).toBe(
			"&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt; &#39;q&#39;",
		);
		expect(escapeHtml("plain text 123")).toBe("plain text 123");
	});
});
