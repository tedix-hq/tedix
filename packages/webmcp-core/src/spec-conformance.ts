/// <reference types="webmcp-types" />
/**
 * Type-only conformance between the structural types in `model-context.ts`
 * and the published WebMCP spec types (`webmcp-types`). Nothing imports this
 * module; `type-check` compiles it, so spec drift fails the build here.
 */
import type {
	ModelContextLike,
	WebMcpRegisterOptions,
	WebMcpSpecTool,
	WebMcpToolAnnotations,
} from "./model-context";

type Assert<T extends true> = T;
type SameKeys<A, B> = [keyof A] extends [keyof B]
	? [keyof B] extends [keyof A]
		? true
		: false
	: false;
type Assignable<From, To> = [From] extends [To] ? true : false;

export type SpecConformance = [
	// Every spec hint is modelled, and nothing beyond the spec.
	Assert<SameKeys<WebMcpToolAnnotations, WebMCP.ToolAnnotations>>,
	Assert<Assignable<WebMcpToolAnnotations, WebMCP.ToolAnnotations>>,
	// The tools the registry hands to registerTool are valid spec tools.
	Assert<Assignable<WebMcpSpecTool, WebMCP.ModelContextTool>>,
	Assert<
		SameKeys<WebMcpRegisterOptions, WebMCP.ModelContextRegisterToolOptions>
	>,
	Assert<
		Assignable<WebMcpRegisterOptions, WebMCP.ModelContextRegisterToolOptions>
	>,
	// A spec host can be projected onto through registerTool.
	Assert<Assignable<WebMCP.ModelContext, ModelContextLike>>,
];
