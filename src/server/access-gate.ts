/**
 * The optional access gate (server fork, 2026-10-27): HTTP Basic auth over
 * EVERY request when LH_ACCESS_PASSWORD is set. The app has no accounts —
 * one data dir, one set of BYOK keys, one learner — so a server exposed
 * beyond localhost needs SOME gate in front of it (the dev docs have said
 * so since the web mode shipped). This is that gate for the common case:
 * a single-user instance behind TLS. Unset = open, exactly as before
 * (reverse-proxy auth, a VPN, or localhost-only binding stay valid).
 *
 * Pure over (headers, env) — the proxy (proxy.ts) calls it per request.
 * Browsers resend Basic credentials on every same-origin request, so the
 * SSE channel and fetch calls ride through once the page has them.
 */
import { timingSafeEqual } from "node:crypto";

export const ACCESS_PASSWORD_VAR = "LH_ACCESS_PASSWORD";
export const ACCESS_USER_VAR = "LH_ACCESS_USER";
export const DEFAULT_ACCESS_USER = "learnharness";

export type AccessVerdict = "open" | "allowed" | "denied";

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

/** The gate's decision for one request. "open" = no password configured. */
export function accessVerdict(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): AccessVerdict {
	const password = env[ACCESS_PASSWORD_VAR];
	if (!password) return "open";
	const user = env[ACCESS_USER_VAR] || DEFAULT_ACCESS_USER;
	const header = headers.get("authorization") ?? "";
	const m = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
	if (!m) return "denied";
	let decoded: string;
	try {
		decoded = Buffer.from(m[1]!, "base64").toString("utf8");
	} catch {
		return "denied";
	}
	const colon = decoded.indexOf(":");
	if (colon < 0) return "denied";
	const suppliedUser = decoded.slice(0, colon);
	const suppliedPassword = decoded.slice(colon + 1);
	// Compare both, always, so timing never reveals which half was wrong.
	const userOk = safeEqual(suppliedUser, user);
	const passwordOk = safeEqual(suppliedPassword, password);
	return userOk && passwordOk ? "allowed" : "denied";
}

/** The 401 challenge headers a denied request answers with. */
export const ACCESS_CHALLENGE_HEADERS = {
	"WWW-Authenticate": 'Basic realm="LearnHarness", charset="UTF-8"',
	"Cache-Control": "no-store",
} as const;
