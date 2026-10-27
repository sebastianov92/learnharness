/**
 * Shared helpers for the payload smoke gates (smoke-server.mjs,
 * smoke-provider-runtime.mjs): a scrubbed child environment and a
 * diagnostic error formatter.
 */
import * as path from "node:path";

/** A child env with NO secrets and a throwaway home/data dir: every key-,
 *  token- or credential-looking variable is stripped, the data and auth
 *  seams point into `home`, and LH_IGNORE_ENV_KEYS hides whatever slipped
 *  through. @param {Record<string, string | undefined>} env @param {string} home
 *  @returns {Record<string, string | undefined>} */
export function probeEnv(env, home) {
	const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
		!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) &&
		!/^(AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|ANTHROPIC_|OPENAI_|OPENROUTER_|GEMINI_|OLLAMA_)/.test(key) &&
		!["NODE_OPTIONS", "NODE_PATH"].includes(key)));
	return {
		...clean,
		HOME: home, USERPROFILE: home,
		APPDATA: path.join(home, "config"), LOCALAPPDATA: path.join(home, "local"),
		XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
		LH_DATA_DIR: path.join(home, "data"), LH_AUTH_FILE: path.join(home, "auth.json"),
		LH_IGNORE_ENV_KEYS: "1", NODE_ENV: "production",
	};
}

/** Keep fetch's nested cause (including AggregateError socket failures), but
 *  never dump arbitrary error properties such as request headers or environment. */
export function formatProbeError(error, depth = 0) {
	if (depth > 5) return "[cause chain truncated]";
	if (!error || typeof error !== "object") return String(error);
	const lines = [typeof error.stack === "string" ? error.stack : `${error.name ?? "Error"}: ${error.message ?? "unknown error"}`];
	for (const field of ["code", "errno", "syscall", "address", "port"]) {
		if (["string", "number"].includes(typeof error[field])) lines.push(`${field}: ${error[field]}`);
	}
	if (error.cause !== undefined) lines.push(`cause: ${formatProbeError(error.cause, depth + 1)}`);
	if (Array.isArray(error.errors)) {
		for (const nested of error.errors.slice(0, 8)) lines.push(`aggregate: ${formatProbeError(nested, depth + 1)}`);
	}
	return lines.join("\n");
}
