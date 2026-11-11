import { expect, it } from "vite-plus/test";
import { resolveWorkActor } from "./work-actor";

it("names agents without the machine they ran on", () => {
	const directory = new Map([
		["external_agent:cedar", { name: "Local cedar agents (ada@laptop.test)" }],
	]);
	expect(
		resolveWorkActor(
			{ type: "external_agent", id: "cedar" },
			"Agent",
			directory,
		).name,
	).toBe("Local cedar agents");
	expect(resolveWorkActor(undefined, "Ada (finance)", new Map()).name).toBe(
		"Ada (finance)",
	);
});
