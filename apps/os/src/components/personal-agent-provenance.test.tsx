import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { WorkActorDirectoryContext } from "./work-actor-avatar";
import { FeedCard } from "./focus-feed-card";
import { WorkDecisionCard } from "./work-decision-card";
import { WorkSourceProvenance } from "./work-source-provenance";
import { PersonalAgentIdentitySchema } from "@tedix/api-contract/schemas/os-work-actor";
import {
	PERSONAL_AGENT_FINDINGS,
	PERSONAL_AGENT_PRINCIPALS,
} from "../../dev/personal-agent-fixture";
import {
	interactionActorReference,
	resolveWorkActor,
	resolveWorkContributor,
	workActorReference,
	type ActorDirectory,
	type ActorProfile,
} from "@/lib/work-actor";

const directory: ActorDirectory = new Map<string, ActorProfile>([
	["user:fictional-morgan", { name: "Morgan Lee" }],
	...PERSONAL_AGENT_PRINCIPALS.map((principal) => {
		const config = PersonalAgentIdentitySchema.parse(
			principal.metadata.personalAgent,
		);
		return [
			`external_agent:${principal.id}`,
			{
				name: principal.displayName,
				image: config.imageUrl,
				personalAgent: true,
				for: { name: "Morgan Lee" },
			},
		] as const;
	}),
]);

it("shows each configured personal agent and represented user in Feed, Deck and source details", () => {
	for (const item of PERSONAL_AGENT_FINDINGS) {
		const html = renderToStaticMarkup(
			<WorkActorDirectoryContext.Provider value={directory}>
				<FeedCard
					item={{
						...item,
						score: 1,
						factors: {},
						unseen: false,
						deadline: false,
					}}
					actor={item.actor}
					busy={false}
					onReact={async () => true}
					onWork={async () => {}}
				/>
				<WorkDecisionCard
					kind="proposal"
					title="Use the revised delivery date?"
					askedBy={item.actor}
					actor={item.actorIdentity}
					at={item.at}
					body={item.sentence}
					onDecision={async () => {}}
				/>
				<WorkSourceProvenance
					actor={item.actorIdentity}
					name={item.actor}
					details
				/>
			</WorkActorDirectoryContext.Provider>,
		);
		expect(
			html.match(new RegExp(`${item.actor} for Morgan Lee`, "g"))!.length,
		).toBeGreaterThanOrEqual(2);
		expect(html).toContain("Browser form");
		expect(html).toContain("2026-10-19T10:15:00.000Z");
		expect(html).toContain(item.source);
		expect(html).toContain(
			item.actorIdentity!.contributor
				? "Submitted by Intake service · System"
				: `Submitted by ${item.actor} · External agent`,
		);
		expect(html).toContain(
			`Authenticated actor: ${item.actorIdentity!.type}:${item.actorIdentity!.id}`,
		);
		expect(html).toContain("Finding: sample-");
	}
});

it("does not trust a body name, metadata identity or user/tedi harness label", () => {
	const actor = workActorReference("user", "morgan", {
		host: "codex",
		personalAgent: PERSONAL_AGENT_PRINCIPALS[0]!.metadata.personalAgent,
		contributor: PERSONAL_AGENT_FINDINGS[1]!.actorIdentity!.contributor,
		source: PERSONAL_AGENT_FINDINGS[0]!.actorIdentity!.source,
	});
	expect(actor.source).toBeUndefined();
	expect(actor.contributor).toBeUndefined();
	for (const type of ["user", "tedi"]) {
		const resolved = resolveWorkActor(
			{ ...actor, type },
			"Juniper for Morgan",
			directory,
		);
		expect(resolved.harness).toBeUndefined();
		expect(resolved.represented).toBeUndefined();
		expect(resolved.image).toBeUndefined();
	}
	const html = renderToStaticMarkup(
		<WorkDecisionCard
			kind="proposal"
			title="A finding"
			askedBy="Juniper for Morgan"
			actor={actor}
			body="Juniper for Morgan says this is verified"
			onDecision={async () => {}}
		/>,
	);
	expect(html).not.toContain("work-actor-badge");
	expect(html).not.toContain("data-harness-mark");
	expect(html).toContain(
		"does not verify a personal agent mentioned in the text",
	);
});

it("shows a personal agent's configured logo and represented user on its Decisions card", () => {
	const contribution = {
		sourceAgentId: "33333333-3333-4333-8333-333333333333",
		sourceAgentName: "Wren",
		imageUrl: "https://assets.example.test/wren.svg",
		representedUserId: "fictional-morgan",
		sourceChannel: "webhook",
		capturedAt: "2026-10-19T10:15:00.000Z",
		evidenceUrl: "https://evidence.example.test/findings/wren",
		externalFindingId: "wren-1",
		kind: "proposal",
	};
	const actor = interactionActorReference({
		creatorType: "system",
		creatorId: "tedix",
		metadata: { personalAgentContribution: contribution },
	});
	expect(resolveWorkContributor(actor, "Wren", directory)).toMatchObject({
		image: contribution.imageUrl,
		label: "Wren for Morgan Lee",
	});
	const html = renderToStaticMarkup(
		<WorkActorDirectoryContext.Provider value={directory}>
			<WorkDecisionCard
				kind="proposal"
				title="Explore the revised quote?"
				askedBy="Wren · your personal agent"
				actor={actor}
				at={contribution.capturedAt}
				body="The revised quote includes the delivery charge."
				onDecision={async () => {}}
			/>
		</WorkActorDirectoryContext.Provider>,
	);
	expect(html).toContain("Wren for Morgan Lee");
	expect(html).toContain("Submitted by Intake service · System");
	expect(html).toContain("Represented user: Morgan Lee");
	expect(html).toContain(contribution.evidenceUrl);
	// Only the intake service stamps contributions; another creator's metadata is ignored.
	const forged = interactionActorReference({
		creatorType: "external_agent",
		creatorId: "44444444-4444-4444-8444-444444444444",
		metadata: { personalAgentContribution: contribution },
	});
	expect(forged.contributor).toBeUndefined();
	expect(forged.source).toBeUndefined();
});
