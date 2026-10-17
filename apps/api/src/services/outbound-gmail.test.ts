import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import {
	outboundMime,
	sendOutboundGmail,
	sentStyleText,
} from "./outbound-gmail";

afterEach(() => vi.unstubAllGlobals());
const draft = {
	channel: "email",
	topic: "partners",
	recipient: "lina@example.test",
	subject: "Grüße",
	body: "Hallo Lina, vielen Dank!",
	reasoning: "Fictional follow-up",
	sources: [],
	risks: [],
};
describe("outbound Gmail adapter", () => {
	it("encodes Unicode and rejects header injection", () => {
		expect(
			atob(outboundMime(draft).replace(/-/g, "+").replace(/_/g, "/")),
		).toContain("To: lina@example.test\r\nSubject: =?UTF-8?B?");
		expect(() =>
			outboundMime({
				...draft,
				recipient: "lina@example.test\r\nBcc: hidden@example.test",
			}),
		).toThrow();
		expect(() =>
			outboundMime({ ...draft, subject: "Hi\r\nBcc: hidden@example.test" }),
		).toThrow();
	});
	it("creates then sends a draft, returning only the sent-message receipt", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ id: "draft-fictional" }))
			.mockResolvedValueOnce(Response.json({ id: "sent-fictional" }));
		vi.stubGlobal("fetch", request);
		expect(await sendOutboundGmail("fictional-token", "raw-content")).toBe(
			"sent-fictional",
		);
		expect(request.mock.calls[0][0]).toMatch(/\/drafts$/);
		expect(request.mock.calls[1][0]).toMatch(/\/drafts\/send$/);
		expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({
			id: "draft-fictional",
		});
	});
	it("learns only plain text, excluding attachments and HTML", () => {
		expect(
			sentStyleText({
				mimeType: "multipart/alternative",
				parts: [
					{
						mimeType: "text/plain",
						body: { data: btoa("Hi Lina, thanks! Rosa") },
					},
					{ mimeType: "text/html", body: { data: btoa("<p>Duplicate</p>") } },
					{
						mimeType: "application/pdf",
						body: { data: btoa("private attachment") },
					},
				],
			}),
		).toBe("Hi Lina, thanks! Rosa");
	});
});
