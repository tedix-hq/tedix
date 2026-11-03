import { readOutboundReply } from "./outbound-gmail";
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import {
	outboundGmailCredential,
	readSentStyleExamples,
	checkSentMailReadAccess,
	outboundMime,
	sendOutboundGmail,
	sentStyleText,
} from "./outbound-gmail";

afterEach(() => vi.unstubAllGlobals());

it.each([
	[200, "verified"],
	[401, "denied"],
	[403, "denied"],
	[404, "unknown"],
	[500, "unknown"],
])(
	"checks full-message read permission without fetching content (%i)",
	async (status, access) => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ messages: [{ id: "sent/example" }] }),
			)
			.mockResolvedValueOnce(new Response(null, { status }));
		vi.stubGlobal("fetch", request);
		expect(await checkSentMailReadAccess("fictional-token")).toBe(access);
		expect(request.mock.calls[1][0]).toContain(
			"sent%2Fexample?format=full&fields=id",
		);
		for (const [url, options] of request.mock.calls) {
			expect(url).not.toContain("payload");
			expect(options.method ?? "GET").toBe("GET");
			expect(options.body).toBeUndefined();
		}
	},
);

it("does not treat an empty sent mailbox as proof of body-read consent", async () => {
	const request = vi.fn().mockResolvedValue(Response.json({ messages: [] }));
	vi.stubGlobal("fetch", request);
	expect(await checkSentMailReadAccess("fictional-token")).toBe("unknown");
	expect(request).toHaveBeenCalledTimes(1);
});

it.each([
	[403, "denied"],
	[503, "unknown"],
])("reports a denied or unavailable listing (%i)", async (status, access) => {
	const request = vi.fn().mockResolvedValue(new Response(null, { status }));
	vi.stubGlobal("fetch", request);
	expect(await checkSentMailReadAccess("fictional-token")).toBe(access);
	expect(request).toHaveBeenCalledTimes(1);
});
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

it("learns from an actual incoming reply, excluding the owner's follow-ups and drafts", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(
			Response.json({
				id: "sent-one",
				threadId: "thread-one",
				internalDate: "1000",
				payload: { headers: [{ name: "Message-ID", value: "<one>" }] },
			}),
		)
		.mockResolvedValueOnce(
			Response.json({
				id: "thread-one",
				messages: [
					{
						id: "follow-up",
						internalDate: "2000",
						labelIds: ["SENT"],
						payload: { headers: [{ name: "In-Reply-To", value: "<one>" }] },
					},
					{
						id: "reply",
						internalDate: "3000",
						labelIds: ["INBOX"],
						payload: { headers: [{ name: "In-Reply-To", value: "<one>" }] },
					},
				],
			}),
		);
	vi.stubGlobal("fetch", fetcher);
	expect(await readOutboundReply("fictional-token", "sent-one")).toBe("reply");
	expect(fetcher).toHaveBeenCalledTimes(2);
});

const connections = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../rpc/routers/connections/policy-resolution", () => ({
	fetchNamedConnection: connections.resolve,
}));
vi.mock("@tedix/db/queries/connection-providers", () => ({
	getConnectionProviderByDescopeAppId: async () => ({ id: "google-gmail" }),
}));

it("uses the shared owner account resolver and probes read access without compose consent", async () => {
	connections.resolve.mockResolvedValue({
		accessToken: "fictional-read-token",
		scopes: [],
	});
	const context = {
		authType: "user",
		user: { sub: "rosa-sub" },
	} as unknown as import("../rpc/orpc").BaseContext;
	expect(
		await outboundGmailCredential(context, "gmail", "rosa-account", "read"),
	).toBe("fictional-read-token");
	expect(connections.resolve).toHaveBeenCalledWith(
		context,
		{ userId: "rosa-sub" },
		"gmail",
		"rosa-account",
	);
	await expect(
		outboundGmailCredential(context, "gmail", "rosa-account"),
	).rejects.toThrow("compose consent");
	await expect(
		outboundGmailCredential(
			{ ...context, authType: "tedi" },
			"gmail",
			"rosa-account",
			"read",
		),
	).rejects.toThrow("signed-in account owner");
});

it("reads at most ten plain-text sent messages with GET requests only", async () => {
	const request = vi.fn(async (url: string, _options: RequestInit) =>
		Response.json(
			url.includes("maxResults")
				? {
						messages: Array.from({ length: 11 }, (_, n) => ({
							id: `mail-${n}`,
						})),
					}
				: {
						payload: {
							mimeType: "text/plain",
							body: { data: btoa("Hi Lina, thanks! Rosa") },
						},
					},
		),
	);
	vi.stubGlobal("fetch", request);
	expect(await readSentStyleExamples("fictional-read-token")).toHaveLength(10);
	expect(request).toHaveBeenCalledTimes(11);
	for (const [url, options] of request.mock.calls) {
		expect(url).toContain("/users/me/messages");
		expect(options.method ?? "GET").toBe("GET");
		expect(options.body).toBeUndefined();
	}
});

it.each([
	[401, "expired or revoked"],
	[403, "Google denied"],
	[429, "Try again later"],
	[500, "Try again later"],
])("explains a failed Gmail read probe (%i)", async (status, reason) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status })),
	);
	await expect(readSentStyleExamples("fictional-read-token")).rejects.toThrow(
		reason,
	);
});
