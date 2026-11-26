import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SETTING = "extensionRenderers.assistantText";

interface SettingHandle {
	get(scope: unknown): unknown;
	override(scope: unknown, value: unknown): void;
	clearOverride(scope: unknown): void;
}

let overridden = false;

async function handle(): Promise<SettingHandle | null> {
	try {
		// The only import of omp internals: dynamic and guarded, since hosts may not expose it.
		const registry = (await import("@oh-my-pi/pi-coding-agent/config/registry")) as {
			lookup?: (id: string) => SettingHandle | undefined;
		};
		return registry.lookup?.(SETTING) ?? null;
	} catch {
		return null;
	}
}

function settingsScope(pi: ExtensionAPI): unknown {
	return pi.pi?.settings;
}

/** Turn on assistant text renderers for this process (runtime override). False when unavailable. */
export async function enableRenderer(pi: ExtensionAPI): Promise<boolean> {
	const h = await handle();
	const scope = settingsScope(pi);
	if (!h || !scope) {
		overridden = false;
		return false;
	}
	try {
		if (h.get(scope) !== true) {
			h.override(scope, true);
			overridden = true;
		}
		return true;
	} catch {
		overridden = false;
		return false;
	}
}

/** Undo enableRenderer's override, if it made one. */
export async function restoreRenderer(pi: ExtensionAPI): Promise<void> {
	if (!overridden) return;
	overridden = false;
	const h = await handle();
	const scope = settingsScope(pi);
	if (!h || !scope) return;
	try {
		h.clearOverride(scope);
	} catch {
		// nothing to restore
	}
}
