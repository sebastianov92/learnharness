/**
 * The optional access gate (server fork, 2026-10-27): LH_ACCESS_PASSWORD
 * turns HTTP Basic auth on for every request; unset keeps the server open.
 * Pure verdicts first, then the proxy's actual responses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { accessVerdict, DEFAULT_ACCESS_USER } from "../src/server/access-gate.ts";
import { proxy, config } from "../proxy.ts";

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("accessVerdict", () => {
	it("no password configured → open, whatever the request carries", () => {
		assert.equal(accessVerdict(new Headers(), {}), "open");
		assert.equal(accessVerdict(new Headers({ authorization: basic("x", "y") }), { LH_ACCESS_PASSWORD: "" }), "open");
	});
	it("password configured → the default user + the password pass; anything else is denied", () => {
		const env = { LH_ACCESS_PASSWORD: "s3cret" };
		assert.equal(accessVerdict(new Headers(), env), "denied");
		assert.equal(accessVerdict(new Headers({ authorization: "Bearer s3cret" }), env), "denied");
		assert.equal(accessVerdict(new Headers({ authorization: "Basic not-base64!!" }), env), "denied");
		assert.equal(accessVerdict(new Headers({ authorization: basic(DEFAULT_ACCESS_USER, "wrong") }), env), "denied");
		assert.equal(accessVerdict(new Headers({ authorization: basic("someone", "s3cret") }), env), "denied");
		assert.equal(accessVerdict(new Headers({ authorization: basic(DEFAULT_ACCESS_USER, "s3cret") }), env), "allowed");
	});
	it("LH_ACCESS_USER renames the user; passwords may contain colons", () => {
		const env = { LH_ACCESS_PASSWORD: "a:b:c", LH_ACCESS_USER: "sebastian" };
		assert.equal(accessVerdict(new Headers({ authorization: basic("sebastian", "a:b:c") }), env), "allowed");
		assert.equal(accessVerdict(new Headers({ authorization: basic(DEFAULT_ACCESS_USER, "a:b:c") }), env), "denied");
	});
});

describe("proxy", () => {
	const withEnv = (password: string | undefined, run: () => void) => {
		const before = process.env.LH_ACCESS_PASSWORD;
		if (password === undefined) delete process.env.LH_ACCESS_PASSWORD; else process.env.LH_ACCESS_PASSWORD = password;
		try { run(); } finally {
			if (before === undefined) delete process.env.LH_ACCESS_PASSWORD; else process.env.LH_ACCESS_PASSWORD = before;
		}
	};
	it("open server: pages and API pass through", () => {
		withEnv(undefined, () => {
			assert.equal(proxy(new NextRequest("http://localhost:3000/")).status, 200);
			assert.equal(proxy(new NextRequest("http://localhost:3000/api/models")).status, 200);
		});
	});
	it("gated server: 401 + a Basic challenge (JSON on the API, text on pages); credentials pass", () => {
		withEnv("s3cret", () => {
			const page = proxy(new NextRequest("http://localhost:3000/chat/new"));
			assert.equal(page.status, 401);
			assert.match(page.headers.get("www-authenticate") ?? "", /^Basic realm="LearnHarness"/);
			const api = proxy(new NextRequest("http://localhost:3000/api/chats"));
			assert.equal(api.status, 401);
			assert.match(api.headers.get("content-type") ?? "", /json/);
			const ok = proxy(new NextRequest("http://localhost:3000/api/chats", { headers: { authorization: basic(DEFAULT_ACCESS_USER, "s3cret") } }));
			assert.equal(ok.status, 200);
		});
	});
	it("the matcher skips static assets only", () => {
		const [pattern] = config.matcher;
		const re = new RegExp(`^${pattern}$`);
		for (const p of ["/", "/chat/abc", "/api/models", "/settings"]) assert.ok(re.test(p), p);
		for (const p of ["/_next/static/chunk.js", "/_next/image?x=1", "/favicon.ico", "/fonts/a.woff2", "/worklets/w.js"]) assert.ok(!re.test(p), p);
	});
});
