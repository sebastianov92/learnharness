import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_CHALLENGE_HEADERS, accessVerdict } from "./src/server/access-gate.ts";

/**
 * The server's one request gate (server fork, 2026-10-27): optional HTTP
 * Basic auth over pages AND the API when LH_ACCESS_PASSWORD is set (see
 * src/server/access-gate.ts). Unset = every request passes, as before.
 * Static assets are excluded by the matcher (they carry nothing private).
 */
export function proxy(request: NextRequest) {
	if (accessVerdict(request.headers) === "denied") {
		const wantsJson = request.nextUrl.pathname.startsWith("/api/");
		return wantsJson
			? NextResponse.json({ error: "Authentication required." }, { status: 401, headers: ACCESS_CHALLENGE_HEADERS })
			: new NextResponse("Authentication required.", { status: 401, headers: ACCESS_CHALLENGE_HEADERS });
	}
	return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/|worklets/).*)"] };
