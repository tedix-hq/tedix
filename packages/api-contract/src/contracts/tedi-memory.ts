import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	EditTediCoreMemoryInputSchema,
	EditTediCoreMemoryOutputSchema,
	ListTediCoreMemoryVersionsInputSchema,
	ListTediCoreMemoryVersionsOutputSchema,
	ReadTediCoreMemoryInputSchema,
	ReadTediMemoryNoteInputSchema,
	TediMemoryNoteSchema,
	WriteTediMemoryNoteInputSchema,
	WriteTediMemoryNoteOutputSchema,
	RestoreTediCoreMemoryVersionInputSchema,
	TediCoreMemorySchema,
} from "../schemas/tedi-memory";

export const tediMemoryContract = oc
	.route({ tags: ["tedi-memory"], prefix: "/tedi-memory" })
	.errors(baseErrors)
	.router({
		readCore: oc
			.route({
				method: "GET",
				path: "/core",
				summary:
					"Read a tedi's core memory: the few short sections it keeps about how the team works, the project, what worked and open threads",
			})
			.input(ReadTediCoreMemoryInputSchema)
			.output(TediCoreMemorySchema),
		editCore: oc
			.route({
				method: "POST",
				path: "/core/edit",
				summary:
					"Replace or add to one section of a tedi's core memory. An edit over the size limit, or one that holds a secret or pasted output, is refused with the reason",
			})
			.input(EditTediCoreMemoryInputSchema)
			.output(EditTediCoreMemoryOutputSchema),
		readNote: oc
			.route({
				method: "GET",
				path: "/notes/read",
				summary: "Read one of a tedi's notes by name",
			})
			.input(ReadTediMemoryNoteInputSchema)
			.output(TediMemoryNoteSchema),
		writeNote: oc
			.route({
				method: "POST",
				path: "/notes/write",
				summary:
					"Write a tedi's note under a name, replacing its text; empty text removes the note. Refused with the reason when it is too long, there are too many notes, or it holds a secret or pasted output",
			})
			.input(WriteTediMemoryNoteInputSchema)
			.output(WriteTediMemoryNoteOutputSchema),
		listCoreVersions: oc
			.route({
				method: "GET",
				path: "/core/versions",
				summary:
					"List earlier versions of a tedi's core memory, newest first, with who or what changed each one",
			})
			.input(ListTediCoreMemoryVersionsInputSchema)
			.output(ListTediCoreMemoryVersionsOutputSchema),
		restoreCoreVersion: oc
			.route({
				method: "POST",
				path: "/core/restore",
				summary:
					"Bring an earlier version of a tedi's core memory back as the newest version",
			})
			.input(RestoreTediCoreMemoryVersionInputSchema)
			.output(TediCoreMemorySchema),
	});

export type TediMemoryContract = typeof tediMemoryContract;
