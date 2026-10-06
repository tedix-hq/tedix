/**
 * Does a tool projection earn its own frame?
 *
 * A turn used to render both the assistant's prose and a sandboxed frame built
 * from the same tool result: seven order counts written out as a list, then the
 * identical seven counts in an iframe below. Two representations of one fact is
 * not richer, it is louder — and the frame is the worse of the two for static
 * content. It cannot be selected, searched, copied, or read as a table by a
 * screen reader; it costs an iframe, a cross-origin document and a sandbox; and
 * it arrives only after the model has streamed its whole layout as JSON, which
 * is why the prose appears to stall mid-answer.
 *
 * So a frame is for what prose cannot be: something a person operates, or a
 * shape a sentence cannot carry. Everything else is markdown the model already
 * wrote.
 */

/** Component names that make a view something to use, not just to read. */
const INTERACTIVE =
	/"(?:type|component)"\s*:\s*"(?:[A-Za-z]*(?:Button|Input|Select|Form|Field|Checkbox|Radio|Switch|Slider|Tabs|Dialog|Chart|Map)[A-Za-z]*)"/;
/** A declared action is the clearest signal: the view does something. */
const ACTION = /"(?:action|actions|onSelect|onClick|onSubmit)"\s*:/;

export interface FrameCandidate {
	/** Present for a json-render view; absent for a generated free-form app. */
	layoutSpec?: unknown;
}

/**
 * Free-form generated apps always frame — bespoke HTML has no prose form. A
 * json-render view frames when it is operable or charted; a static table, list
 * or metric row does not, because the answer already says it.
 */
export function projectionEarnsFrame(projection: FrameCandidate): boolean {
	if (!projection || typeof projection !== "object") return false;
	if (projection.layoutSpec === undefined || projection.layoutSpec === null)
		return true;
	let serialized: string;
	try {
		serialized = JSON.stringify(projection.layoutSpec);
	} catch {
		// An unserializable spec is not something to reason about; show it and
		// let the renderer decide.
		return true;
	}
	if (!serialized) return true;
	return ACTION.test(serialized) || INTERACTIVE.test(serialized);
}
