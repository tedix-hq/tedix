import { z } from "zod";
import {
	OsBlueprintDefinitionSchema,
	OsPresentationPatchOpSchema,
	OsPresentationSlideSchema,
	OsWorkspaceResourceSlotSchema,
	type OsBlueprintDefinition,
} from "../../schemas/os-workspaces";

import { SLIDES_BLUEPRINT_VERSION } from "../../assets/office-editor-versions";
import { OS_DECK_MAX_SLIDES } from "../../utils/os-output-limits";
import portableSlidesClient from "./slides-client.v2.generated.json";

export const SLIDES_SERVER_SOURCE = String.raw`
function outline(content) {
  if (!content.deck) return content.slides;
  return content.deck.slides.map(slide => {
    const ordered = [...slide.elements].sort((a,b) => a.y-b.y || a.x-b.x);
    return {title:(ordered.find(element => element.type === "title")?.text ?? slide.name).slice(0,300),
      bullets:ordered.filter(element => element.type === "bullet").flatMap(element => (element.text || "").split("\n")).map(text => text.trim()).filter(Boolean).slice(0,30),
      ...(slide.notes ? {notes:slide.notes} : {})};
  });
}
export class App {
  constructor(ctx,env) { this.env = env; }
  get slot() {
    const slot = this.env.CONFIG?.settings?.slot;
    if (typeof slot !== "string" || !slot) throw new Error("Presentation slot is not configured");
    return slot;
  }
  async readPresentation() {
    const result = await this.env.TEDIX.outputsRead(this.slot,{});
    if (result.revision?.content?.kind !== "presentation") throw new Error("This slot is not a presentation");
    return {...result,outline:outline(result.revision.content)};
  }
  async replacePresentation(input) {
    if (input?.content?.kind !== "presentation" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("A presentation and expected revision are required");
    await this.env.TEDIX.outputsWrite(this.slot,{content:input.content,expectedRevision:input.expectedRevision});
    return this.readPresentation();
  }
  async editSlides(input) {
    if (!Array.isArray(input?.ops) || !input.ops.length || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("Slide edits and expected revision are required");
    await this.env.TEDIX.outputsPatch(this.slot,{kind:"presentation",ops:input.ops,expectedRevision:input.expectedRevision});
    return this.readPresentation();
  }
  async exportOutline() {
    const result = await this.readPresentation();
    return {outputId:result.output.id,revision:result.revision.revision,title:result.output.title,mimeType:"text/markdown",projection:"semantic_outline",
      text:result.outline.map((slide,index) => "# " + (index+1) + ". " + slide.title + "\n\n" + slide.bullets.map(text => "- " + text).join("\n") + (slide.notes ? "\n\nNotes: " + slide.notes : "")).join("\n\n---\n\n")};
  }
}
`;

export const SLIDES_CLIENT_SOURCE = portableSlidesClient.source;

export function buildSlidesBlueprint(
	slot = "presentation",
): OsBlueprintDefinition {
	OsWorkspaceResourceSlotSchema.parse(slot);
	const expectedRevision = { type: "integer", minimum: 1 };
	const patch = z.toJSONSchema(OsPresentationPatchOpSchema);
	const slide = z.toJSONSchema(OsPresentationSlideSchema);
	const object = (
		properties: Record<string, unknown>,
		required: string[] = [],
	) => ({
		type: "object",
		properties,
		required,
		additionalProperties: false,
	});
	return OsBlueprintDefinitionSchema.parse({
		gadgets: [
			{
				name: "Slides",
				manifest: {
					entry: "tedix:runtime/v1",
					description:
						"Write, arrange and present slides with revision history.",
					capabilities: [],
					config: {
						version: 1,
						settings: { slot, blueprintVersion: SLIDES_BLUEPRINT_VERSION },
					},
					resourceGrants: [
						{
							slot,
							operations: ["outputs.read", "outputs.write", "outputs.patch"],
						},
					],
					operations: [
						{
							name: "readPresentation",
							description: "Read the current presentation and revision.",
							input: object({}),
							effect: "read",
							outputSlot: slot,
						},
						{
							name: "replacePresentation",
							description:
								"Replace canonical content at an expected revision; preserve deck fields to retain canvas artwork.",
							input: object(
								{
									content: object(
										{
											kind: { type: "string", const: "presentation" },
											slides: {
												type: "array",
												items: slide,
												maxItems: OS_DECK_MAX_SLIDES,
											},
											deck: { type: "object" },
										},
										["kind", "slides"],
									),
									expectedRevision,
								},
								["content", "expectedRevision"],
							),
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "editSlides",
							description:
								"Apply ordered slide insert, replace, delete or move edits while retaining canvas content.",
							input: object(
								{
									ops: {
										type: "array",
										items: patch,
										minItems: 1,
										maxItems: 100,
									},
									expectedRevision,
								},
								["ops", "expectedRevision"],
							),
							effect: "write",
							outputSlot: slot,
						},
						{
							name: "exportOutline",
							description:
								"Export the saved semantic slide outline, excluding canvas artwork.",
							input: object({}),
							effect: "read",
							outputSlot: slot,
						},
					],
				},
				files: {
					"client.js": SLIDES_CLIENT_SOURCE,
					"server.js": SLIDES_SERVER_SOURCE,
					"README.md":
						"# Slides\n\nThis gadget reads and edits one named presentation output. Saving checks the revision you opened. If that revision changed, your draft stays available until you choose to discard it and reload. An editor with no unsaved work refreshes when a saved-output notice arrives.\n\nThe canvas lets you change text, section labels, pills, images, SVG, shapes, cards, arrows, styles, backgrounds, fonts, layers, and a logo that appears on every slide. Presentations open in view mode; press E to edit. Hold Shift or drag a box to choose several elements, then move, align, or distribute them. Elements can be moved or resized partly outside a slide, and text can grow with its content. Add a slide from a layout, change slide order, make a copy, or remove it. You can also edit speaker notes, zoom the canvas, and present every slide.\n\nSaving keeps slide identities, styling, and artwork. Presentation-file, PDF, and HTML downloads use the bound output after saving at the expected revision. A Markdown download contains only the semantic outline. Templates do not include presentation content, chat, or credentials.\n\nAgents can call readPresentation({}), replacePresentation({content,expectedRevision}), editSlides({ops,expectedRevision}), and exportOutline({}). Writes use scoped output capabilities and continue to follow the approval policy.\n",
				},
			},
		],
		requirements: {
			version: 1,
			outputs: [
				{
					gadget: "Slides",
					kind: "presentation",
					title: "Untitled presentation",
					slot,
				},
			],
		},
	});
}
