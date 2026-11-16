import { isRedirect } from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import { Route } from "@/routes/_session/_tenant/skills.$skillId.schedule";

it("sends an old Schedule link to the skill's Settings tab", () => {
	const beforeLoad = Route.options.beforeLoad as (context: {
		params: { skillId: string };
	}) => void;
	let thrown: unknown;
	try {
		beforeLoad({ params: { skillId: "skill-1" } });
	} catch (error) {
		thrown = error;
	}
	expect(isRedirect(thrown)).toBe(true);
	expect((thrown as { options: unknown }).options).toMatchObject({
		to: "/skills/$skillId/settings",
		params: { skillId: "skill-1" },
		replace: true,
	});
});
