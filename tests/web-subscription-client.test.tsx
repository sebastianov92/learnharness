import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { parseHTML } from "linkedom";
import { createNotifyHub } from "../components/server-events.tsx";
import { createWebChatGPTBridge, createWebNativeBridge } from "../components/settings/subscription-client.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document });
const originalFetch = globalThis.fetch;
const action = "/api/subscriptions/browser?id=00000000-0000-4000-8000-000000000001";
afterEach(() => { globalThis.fetch = originalFetch; delete window.__lhTestBridges; });

test("web ChatGPT reserves a new tab before async login, navigates only to an opaque action and receives push/resync", async () => {
	const calls: string[] = [];
	const tab = { opener: {}, closed: false, location: { href: "about:blank" }, close() { this.closed = true; } };
	window.open = (() => { calls.push("tab"); return tab; }) as unknown as typeof window.open;
	const safe = { available: true, pending: true, allowBackgroundUse: true, activeId: null, accounts: [], error: null };
	globalThis.fetch = async (url, options) => {
		assert.equal(url, "/api/subscriptions"); assert.equal(new Headers(options?.headers).get("x-learnharness-subscriptions"), "1");
		if (!options?.method) return Response.json({ chatgpt: safe, native: [] });
		calls.push("login"); assert.equal(tab.opener, null);
		assert.deepEqual(JSON.parse(String(options.body)), { providerId: "chatgpt", op: "login" });
		return Response.json({ value: safe, browserAction: action });
	};
	const hub = createNotifyHub(), bridge = createWebChatGPTBridge(hub);
	assert.deepEqual(await bridge.login(), safe); assert.deepEqual(calls, ["tab", "login"]);
	assert.equal(tab.location.href, action); assert(!tab.closed);
	let updates = 0; const off = bridge.onChange(() => updates++);
	hub.dispatch("subscriptions-changed", "{}"); hub.fireOpen(); assert.equal(updates, 2);
	off(); hub.fireOpen(); assert.equal(updates, 2);
	assert.deepEqual(await bridge.status(), safe);
});

test("blocked popups do not start OAuth; failed login closes the reserved tab", async () => {
	const bridge = createWebChatGPTBridge(null);
	window.open = () => null;
	globalThis.fetch = async () => assert.fail("blocked popup must not start sign-in");
	await assert.rejects(bridge.login(), /Allow a sign-in tab/);
	const tab = { opener: {}, closed: false, close() { this.closed = true; } };
	window.open = (() => tab) as unknown as typeof window.open;
	globalThis.fetch = async () => new Response(null, { status: 400 });
	await assert.rejects(bridge.login()); assert(tab.closed);
});

test("native web login retains device prompts; only the explicit Open browser action opens a tab", async () => {
	const requests: Record<string, unknown>[] = []; let tabs = 0;
	const tab = { opener: {}, closed: false, location: { href: "" }, close() {} };
	window.open = (() => { tabs++; return tab; }) as unknown as typeof window.open;
	globalThis.fetch = async (_url, options) => {
		const command = JSON.parse(String(options?.body)); requests.push(command);
		return Response.json(command.op === "open" ? { browserAction: action } : {});
	};
	const bridge = createWebNativeBridge(null);
	await bridge.login("github-copilot", false); assert.equal(tabs, 0);
	await bridge.respond("github-copilot", "attempt", "prompt", "");
	await bridge.open("github-copilot", "attempt", "action"); assert.equal(tabs, 1); assert.equal(tab.location.href, action);
	assert.deepEqual(requests, [{ providerId: "github-copilot", op: "login", enabled: false }, { providerId: "github-copilot", op: "respond", attemptId: "attempt", promptId: "prompt", value: "" }, { providerId: "github-copilot", op: "open", attemptId: "attempt", actionId: "action" }]);
});


test("web notices identify the server machine and same-machine ChatGPT sign-in; desktop copy stays unchanged", async () => {
	const { CHATGPT_NOTICE, chatGPTNotice } = await import("../components/settings/chatgpt-connection.tsx");
	const { subscriptionNotice, subscriptionDisconnectCopy } = await import("../components/settings/subscription-connections.tsx");
	assert.equal(chatGPTNotice(), CHATGPT_NOTICE); assert(CHATGPT_NOTICE.includes("on this device"));
	assert(chatGPTNotice(true).includes("on the machine running LearnHarness"));
	assert(chatGPTNotice(true).endsWith("Complete ChatGPT sign-in in a browser on that same machine."));
	for (const label of ["GitHub Copilot", "Grok"]) {
		assert(subscriptionNotice(label).includes("stored locally")); assert(subscriptionDisconnectCopy(label).includes("from this device"));
		assert(subscriptionNotice(label, true).includes("on the machine running LearnHarness"));
		assert(subscriptionDisconnectCopy(label, true).includes("from the machine running LearnHarness"));
	}
});

