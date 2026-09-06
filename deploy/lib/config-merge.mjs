/**
 * Regenerate the deployed config by merging shipped defaults with what's already
 * deployed — never a blind overwrite. See docs/deploy-architecture.md.
 *
 *   new_config = mergeConfig(example_defaults, current_config)
 *
 * Field-level precedence, because the two halves have different owners:
 *   - `tools` (the allowlist) is a SECURITY control → taken from the example, so a
 *     removal/tightening in an update always applies (a "current wins" merge would
 *     silently keep a tool the repo dropped).
 *   - `owners` → current entries win and are preserved; example owners not present
 *     in current are added (a newly-onboarded org in the repo shows up on upgrade).
 *   - `listen` / `upstream` / `defaultOwner` / `app` / `secrets` → current wins if
 *     set, else the example's value.
 *
 * On a first install (no current), the example is used as-is.
 */
export function mergeConfig(example, current) {
	if (!example || typeof example !== "object" || Array.isArray(example)) throw new Error("mergeConfig: example config must be an object");
	if (!current) return structuredClone(example);
	if (typeof current !== "object" || Array.isArray(current)) throw new Error("mergeConfig: current config must be an object");

	const out = structuredClone(example);

	// tools: always authoritative from the example (already copied into out).

	// scalars: current wins when defined.
	for (const k of ["listen", "upstream", "defaultOwner"]) {
		if (current[k] !== undefined) out[k] = current[k];
	}

	// owners: current entries win per-owner; example owners not in current are kept.
	out.owners = { ...(example.owners ?? {}), ...(current.owners ?? {}) };

	// optional blocks: current wins if present.
	for (const k of ["app", "secrets"]) {
		if (current[k] !== undefined) out[k] = current[k];
	}

	return out;
}
