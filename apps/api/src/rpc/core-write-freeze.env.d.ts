/** Set to "1" during a core store switch to refuse writes; reads keep working. */
interface CloudflareEnv {
	CORE_WRITE_FREEZE?: string;
}
