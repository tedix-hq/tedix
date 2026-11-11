/**
 * How large a workspace file may be. These numbers live apart from the
 * schemas so an editor bundle can read them without carrying the schemas.
 */

/**
 * The largest Output content one stored revision may hold, as UTF-8 bytes of
 * its JSON. Images are stored apart and do not count. The bound is the API
 * isolate's 128 MB of memory: parsed content takes about twice its JSON size,
 * a save holds the stored copy, the changed copy and both texts at once, and
 * a merge with someone else's save adds the base they share. The editors'
 * host and the API both refuse more.
 */
export const OS_OUTPUT_CONTENT_MAX_BYTES = 8_000_000;

/**
 * Top-level blocks one document may hold: as many as its rich body may hold
 * paragraphs, so a long document's plain-block copy is never the tighter bound.
 */
export const OS_DOCUMENT_MAX_BLOCKS = 10_000;

/** Rows one sheet tab may hold. */
export const OS_SHEET_MAX_ROWS = 50_000;
/** Columns one sheet tab may hold: A to ZZ. */
export const OS_SHEET_MAX_COLUMNS = 702;
/** Characters one sheet cell may hold. */
export const OS_SHEET_CELL_MAX_LENGTH = 8_192;

/** Slides one deck may hold. */
export const OS_DECK_MAX_SLIDES = 500;
/** Elements one slide may hold. */
export const OS_SLIDE_MAX_ELEMENTS = 1_000;
/** Characters of text one slide may hold in all: its elements and its notes. */
export const OS_SLIDE_MAX_TEXT_CHARS = 900_000;

/** Steps each editor can undo. */
export const OS_EDITOR_UNDO_STEPS = 50;

/** The longest side, in pixels, an inserted image is scaled down to. */
export const OS_IMAGE_MAX_DIMENSION = 1_600;
/** The largest still image an editor stores after scaling it down, in bytes. */
export const OS_IMAGE_MAX_STILL_BYTES = 1_400_000;
/** The largest animated GIF an editor stores as uploaded, in bytes. */
export const OS_IMAGE_MAX_GIF_BYTES = 2_700_000;
