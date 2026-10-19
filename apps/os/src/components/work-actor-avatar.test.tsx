import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import {
	WorkActorAvatar,
	WorkActorDirectoryContext,
} from "./work-actor-avatar";
import { resolveWorkActor, workActorReference } from "@/lib/work-actor";

const directory = new Map([
	[
		"user:pine-owner",
		{ name: "Morgan Lee", image: "https://images.example.test/morgan.png" },
	],
	[
		"external_agent:pine-laptop",
		{
			name: "Renamed laptop",
			for: {
				name: "Morgan Lee",
				image: "https://images.example.test/morgan.png",
			},
		},
	],
	["tedi:cedar", { name: "Cedar", image: "🌲" }],
]);
it("uses provenance over misleading names, across renamed sessions and harnesses", () => {
	const actor = workActorReference("external_agent", "pine-laptop", {
		agentHarness: "claude-code",
		agentSession: "codex:older",
	});
	const html = renderToStaticMarkup(
		<WorkActorDirectoryContext.Provider value={directory}>
			<WorkActorAvatar actor={actor} name="Codex for Pine" />
		</WorkActorDirectoryContext.Provider>,
	);
	expect(html).toContain('data-harness-mark="claude-code"');
	expect(html).not.toContain('data-harness-mark="codex"');
	expect(html).toContain('aria-label="Claude Code for Morgan Lee"');
	expect(html).toContain("work-actor-badge");
	expect(
		resolveWorkActor(undefined, "Codex", directory).harness,
	).toBeUndefined();
	expect(
		resolveWorkActor(
			{ type: "external_agent", id: "missing", harness: "unknown" },
			"Agent",
			directory,
		).label,
	).toBe("Agent");
	expect(
		resolveWorkActor(
			undefined,
			"11111111-1111-4111-8111-111111111111 session",
			directory,
		).label,
	).toBe("Agent");
});
it("uses the tedi avatar and person photo data and exposes session details on tap", async () => {
	expect(
		renderToStaticMarkup(
			<WorkActorDirectoryContext.Provider value={directory}>
				<WorkActorAvatar actor={{ type: "tedi", id: "cedar" }} />
			</WorkActorDirectoryContext.Provider>,
		),
	).toContain("🌲");
	expect(
		resolveWorkActor({ type: "user", id: "pine-owner" }, "Person", directory)
			.image,
	).toBe("https://images.example.test/morgan.png");
	expect(
		resolveWorkActor(
			{ type: "tedi", id: "cedar", harness: "codex" },
			"Agent",
			directory,
		).label,
	).toBe("Cedar");
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<WorkActorDirectoryContext.Provider value={directory}>
					<WorkActorAvatar
						actor={{ type: "user", id: "pine-owner", harness: "codex" }}
						detail="Codex session · Pine Studio"
					/>
				</WorkActorDirectoryContext.Provider>,
			),
		);
		const trigger = host.querySelector("button")!;
		expect(trigger.getAttribute("title")).toBe("Morgan Lee");
		await act(async () => trigger.click());
		expect(document.body.textContent).toContain("Codex session · Pine Studio");
		expect(document.body.textContent).not.toContain("Codex for Morgan Lee");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
