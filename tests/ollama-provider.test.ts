/**
 * Ollama — the local/offline provider (server fork, 2026-10-27).
 *
 * Pure projection first (host normalization, context-window rule, the
 * Model shape per capability), then the federation end-to-end against a
 * STUBBED Ollama API (globalThis.fetch answers /api/tags + /api/show):
 * refresh → pi-ai collection → catalog projection → settings validation
 * → engine build → the key gate — and the honest failure modes
 * (unreachable keeps the last list + reports; unconfigured lists nothing).
 *
 * LH_AUTH_FILE redirects to a fresh tmp dir BEFORE the server imports
 * (the seam is module-load bound). No network: fetch is stubbed.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

for (const name of ["OLLAMA_HOST", "OLLAMA_CONTEXT_LENGTH", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]) delete process.env[name];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ollama-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { normalizeOllamaHost, validateKeyShape, isSecretAuthKey, AUTH_KEYS, OLLAMA_HOST_VAR } = await import("../src/core/auth-keys.ts");
const { fetchOllamaModels, ollamaContextWindow, ollamaHost, ollamaModel, ollamaStatus, parseModelContextLength, parseNumCtx, refreshOllamaModels, resetOllamaStatus } = await import("../src/agent/ollama.ts");
const { piEngineForSpec, piModels } = await import("../src/agent/models.ts");
const { catalogProviders, modelCatalog, validateModelsSettings, refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
const { keyStatuses, providerKeyPresent, saveKey, deleteKey } = await import("../src/server/keys.ts");
const { keyStatusLine, ollamaStatusLine } = await import("../components/settings/keys-section.tsx");
const { providerKeyMissing } = await import("../src/core/settings.ts");
const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");

describe("normalizeOllamaHost / the OLLAMA_HOST shape gate", () => {
	it("adds http://, strips trailing slashes and /v1, keeps paths and ports", () => {
		assert.equal(normalizeOllamaHost("localhost:11434"), "http://localhost:11434");
		assert.equal(normalizeOllamaHost("  http://ollama:11434/  "), "http://ollama:11434");
		assert.equal(normalizeOllamaHost("https://ai.example.com/ollama/v1/"), "https://ai.example.com/ollama");
		assert.equal(normalizeOllamaHost("http://10.0.0.5"), "http://10.0.0.5");
	});
	it("rejects empty, non-http schemes and junk", () => {
		assert.equal(normalizeOllamaHost(""), null);
		assert.equal(normalizeOllamaHost("   "), null);
		assert.equal(normalizeOllamaHost("ftp://x"), null);
		assert.equal(normalizeOllamaHost("http://"), null);
		assert.equal(normalizeOllamaHost("not a url at all"), null);
	});
	it("validateKeyShape(OLLAMA_HOST) is the URL rule, and the entry is NOT a secret", () => {
		assert.ok(validateKeyShape(OLLAMA_HOST_VAR, "localhost:11434").ok);
		const bad = validateKeyShape(OLLAMA_HOST_VAR, "nope nope");
		assert.ok(!bad.ok);
		if (!bad.ok) assert.match(bad.error, /http\(s\) address/);
		assert.equal(isSecretAuthKey(OLLAMA_HOST_VAR), false);
		assert.equal(isSecretAuthKey("DEEPGRAM_API_KEY"), true);
		assert.equal(isSecretAuthKey("OPENAI_API_KEY"), true);
		assert.ok(AUTH_KEYS.some((k) => k.id === OLLAMA_HOST_VAR && k.secret === false && k.placeholder));
	});
});

describe("the context-window rule", () => {
	it("num_ctx from the Modelfile wins; else the OLLAMA_CONTEXT_LENGTH hint; else Ollama's 4096 default — never above the trained maximum", () => {
		assert.equal(parseNumCtx("stop <|eot|>\nnum_ctx 32768\ntemperature 0.7"), 32768);
		assert.equal(parseNumCtx("temperature 0.7"), undefined);
		assert.equal(parseModelContextLength({ "general.architecture": "llama", "llama.context_length": 131072 }), 131072);
		assert.equal(parseModelContextLength({ "general.architecture": "llama" }), undefined);
		const info = { "llama.context_length": 131072 };
		assert.equal(ollamaContextWindow({ model_info: info, parameters: "num_ctx 16384" }, 65536), 16384);
		assert.equal(ollamaContextWindow({ model_info: info }, 65536), 65536);
		assert.equal(ollamaContextWindow({ model_info: info }, undefined), 4096);
		assert.equal(ollamaContextWindow({ model_info: { "x.context_length": 2048 } }, 65536), 2048, "capped at the trained maximum");
		assert.equal(ollamaContextWindow({}, undefined), 4096);
	});
});

describe("ollamaModel — the pi-ai projection per capability", () => {
	const host = "http://ollama:11434";
	it("a plain chat model with tools: text-only, no reasoning, $0, /v1 base", () => {
		const m = ollamaModel(host, "llama3.2:3b", { capabilities: ["completion", "tools"], model_info: { "llama.context_length": 131072 } }, 32768);
		assert.equal(m.id, "llama3.2:3b");
		assert.equal(m.name, "llama3.2:3b");
		assert.equal(m.provider, "ollama");
		assert.equal(m.api, "openai-completions");
		assert.equal(m.baseUrl, `${host}/v1`);
		assert.deepEqual(m.input, ["text"]);
		assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(m.contextWindow, 32768);
		assert.equal(m.maxTokens, 16384);
		assert.equal(m.reasoning, false);
		assert.equal(m.compat?.supportsReasoningEffort, false);
		assert.equal(m.compat?.maxTokensField, "max_tokens");
	});
	it("no tools → the name says so (the harness needs tools)", () => {
		const m = ollamaModel(host, "tinyllama", { capabilities: ["completion"] }, undefined);
		assert.equal(m.name, "tinyllama (no tool support)");
	});
	it("vision → image input; thinking (non gpt-oss) → reasoning with only `off` (thinks by default)", () => {
		const v = ollamaModel(host, "llava:7b", { capabilities: ["completion", "vision"] }, undefined);
		assert.deepEqual(v.input, ["text", "image"]);
		const t = ollamaModel(host, "qwen3:8b", { capabilities: ["completion", "tools", "thinking"] }, undefined);
		assert.equal(t.reasoning, true);
		assert.equal(t.compat?.supportsReasoningEffort, false);
		assert.deepEqual(getSupportedThinkingLevels(t), ["off"]);
	});
	it("gpt-oss → low/medium/high through reasoning_effort", () => {
		const g = ollamaModel(host, "gpt-oss:20b", { capabilities: ["completion", "tools", "thinking"], details: { family: "gptoss" } }, undefined);
		assert.equal(g.compat?.supportsReasoningEffort, true);
		assert.deepEqual(getSupportedThinkingLevels(g), ["off", "low", "medium", "high"]);
	});
});

// ─── the stubbed Ollama API ──────────────────────────────────────────────────

type Stub = { tags: Record<string, unknown> | Error; show: Record<string, Record<string, unknown>> };
const realFetch = globalThis.fetch;
let calls: string[] = [];
function stubOllama(stub: Stub) {
	calls = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/api/tags")) {
			if (stub.tags instanceof Error) throw stub.tags;
			return new Response(JSON.stringify(stub.tags), { status: 200, headers: { "content-type": "application/json" } });
		}
		if (url.endsWith("/api/show")) {
			const { model } = JSON.parse(String(init?.body)) as { model: string };
			const body = stub.show[model];
			return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("not found", { status: 404 });
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch;
}
before(() => resetOllamaStatus());
after(() => { globalThis.fetch = realFetch; });

const TAGS = { models: [{ name: "llama3.2:3b" }, { name: "qwen3:8b" }, { name: "nomic-embed-text" }, { name: "mystery:latest" }] };
const SHOW = {
	"llama3.2:3b": { capabilities: ["completion", "tools"], model_info: { "llama.context_length": 131072 }, parameters: "num_ctx 16384" },
	"qwen3:8b": { capabilities: ["completion", "tools", "thinking", "vision"], model_info: { "qwen3.context_length": 40960 } },
	"nomic-embed-text": { capabilities: ["embedding"] },
};

describe("fetchOllamaModels", () => {
	it("lists chat models from tags+show, skips embedding models, degrades a failed show to defaults", async () => {
		stubOllama({ tags: TAGS, show: SHOW });
		const models = await fetchOllamaModels("http://ollama:11434");
		assert.deepEqual(models.map((m) => m.id), ["llama3.2:3b", "mystery:latest", "qwen3:8b"]);
		assert.equal(models.find((m) => m.id === "llama3.2:3b")!.contextWindow, 16384);
		assert.equal(models.find((m) => m.id === "mystery:latest")!.contextWindow, 4096, "unreadable show → conservative defaults");
		assert.deepEqual(models.find((m) => m.id === "qwen3:8b")!.input, ["text", "image"]);
		assert.ok(calls.includes("GET http://ollama:11434/api/tags"));
		assert.equal(calls.filter((c) => c.startsWith("POST")).length, 4);
	});
});

describe("federation end-to-end (refresh → collection → catalog → validation → engine → gate)", () => {
	it("unconfigured: no host, no models, keyPresent false, the gate refuses, the status is quiet", async () => {
		delete process.env.OLLAMA_HOST;
		assert.equal(ollamaHost(), undefined);
		const status = await refreshOllamaModels(piModels());
		assert.equal(status.configured, false);
		assert.equal(status.models, 0);
		assert.equal(providerKeyPresent("ollama"), false);
		assert.equal(catalogProviders().find((p) => p.id === "ollama")?.keyPresent, false);
		assert.ok(!modelCatalog().models.some((m) => m.provider === "ollama"));
		assert.equal(ollamaStatusLine(status), null);
		assert.equal(providerKeyMissing("ollama", ["strong"]).error, "No Ollama host key is set — add one in Settings → Keys");
	});

	it("configured through the keys route: the host lands normalized + unmasked, the catalog federates the server's list", async () => {
		stubOllama({ tags: TAGS, show: SHOW });
		const saved = saveKey(OLLAMA_HOST_VAR, "ollama:11434/");
		assert.ok(saved.ok);
		if (saved.ok) {
			assert.equal(saved.status.masked, "http://ollama:11434", "a URL leaves unmasked");
			assert.equal(keyStatusLine(saved.status), "http://ollama:11434");
		}
		assert.equal(ollamaHost(), "http://ollama:11434");
		assert.equal(providerKeyPresent("ollama"), true);

		await refreshConnectionCatalog();
		const status = ollamaStatus();
		assert.equal(status.configured, true);
		assert.equal(status.models, 3);
		assert.equal(status.error, null);
		assert.equal(ollamaStatusLine(status), "3 models");

		const catalog = modelCatalog();
		assert.equal(catalog.providers.find((p) => p.id === "ollama")?.keyPresent, true);
		const local = catalog.models.filter((m) => m.provider === "ollama");
		assert.deepEqual(local.map((m) => m.id), ["llama3.2:3b", "mystery:latest", "qwen3:8b"]);
		const qwen = local.find((m) => m.id === "qwen3:8b")!;
		assert.deepEqual(qwen.supportedLevels, ["off"]);
		assert.equal(qwen.cost.input, 0);
		assert.deepEqual(qwen.input, ["text", "image"]);

		// Settings validation accepts the slot; the engine resolves the model at level off.
		assert.deepEqual(validateModelsSettings({ strong: { model: { provider: "ollama", id: "llama3.2:3b" } } }), { ok: true });
		assert.ok(!validateModelsSettings({ strong: { model: { provider: "ollama", id: "nomic-embed-text" } } }).ok, "embedding models never list");
		const engine = piEngineForSpec({ provider: "ollama", id: "llama3.2:3b", thinkingLevel: "high" });
		assert.equal(engine.model.baseUrl, "http://ollama:11434/v1");
		assert.equal(engine.level, "off", "a non-reasoning model clamps every level to off");

		// The keys status row carries the URL for the settings page.
		const row = keyStatuses().find((s) => s.id === OLLAMA_HOST_VAR)!;
		assert.equal(row.present, true);
		assert.equal(row.source, "file");
		assert.equal(row.masked, "http://ollama:11434");
	});

	it("unreachable: the previous list stays, the status carries the error", async () => {
		stubOllama({ tags: new Error("connect ECONNREFUSED"), show: {} });
		await refreshConnectionCatalog("ollama");
		const status = ollamaStatus();
		assert.equal(status.configured, true);
		assert.match(status.error ?? "", /ECONNREFUSED/);
		assert.equal(status.models, 3, "pi-ai keeps the last list on failure");
		assert.match(ollamaStatusLine(status)!, /^unreachable — /);
	});

	it("a changed server list replaces the catalog on the next refresh; deleting the host un-federates", async () => {
		stubOllama({ tags: { models: [{ name: "llama3.2:3b" }] }, show: SHOW });
		await refreshConnectionCatalog("ollama");
		assert.deepEqual(modelCatalog().models.filter((m) => m.provider === "ollama").map((m) => m.id), ["llama3.2:3b"]);
		assert.equal(ollamaStatus().models, 1);
		assert.equal(ollamaStatusLine(ollamaStatus()), "1 model");

		deleteKey(OLLAMA_HOST_VAR);
		assert.equal(ollamaHost(), undefined);
		await refreshConnectionCatalog("ollama");
		assert.equal(providerKeyPresent("ollama"), false);
		assert.ok(!modelCatalog().models.some((m) => m.provider === "ollama"), "no host → not federated, whatever the collection still holds");
	});
});
