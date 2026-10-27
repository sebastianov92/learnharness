/**
 * Ollama — the LOCAL / OFFLINE model provider (server fork, 2026-10-27).
 *
 * pi-ai ships no Ollama catalog (the models are whatever the user pulled),
 * so this module builds a DYNAMIC pi-ai provider over Ollama's OpenAI-
 * compatible endpoint (`<host>/v1`). The model list comes from the Ollama
 * API itself — `GET /api/tags` for the names, `POST /api/show` per model
 * for its capabilities (tools / vision / thinking) and context length —
 * and is refreshed every time the picker asks (GET /api/models →
 * refreshConnectionCatalog → refreshOllamaModels).
 *
 * Configuration is ONE value — OLLAMA_HOST (e.g. http://ollama:11434) —
 * which rides the SAME keys seam as every API key (auth.json ↔ env, env
 * wins; src/server/keys.ts). Unset = the provider is not configured: no
 * models, no row in the picker, the chat gate refuses honestly. Every
 * Ollama model costs 0, so the cost meter reads $0 for local sessions.
 *
 * Agent-layer module: it reads process.env (the keys seam's reflection)
 * and never imports the server or store layers (architecture §2).
 */
import { createProvider, type Api, type Model, type Models, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OLLAMA_CONTEXT_HINT_VAR, OLLAMA_HOST_VAR, OLLAMA_PROVIDER_ID, normalizeOllamaHost, type OllamaStatus } from "../core/auth-keys.ts";

export type { OllamaStatus };

/** What Ollama's /api/show reports about one model (the fields we read). */
interface OllamaShow {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
	parameters?: string;
	details?: { family?: string; families?: string[]; parameter_size?: string };
}

const TAGS_TIMEOUT_MS = 8_000;
const SHOW_TIMEOUT_MS = 8_000;
/** Ollama's own default context window when nothing else is configured. */
const OLLAMA_DEFAULT_CONTEXT = 4096;
/** Output cap sent as max_tokens (Ollama maps it to num_predict). */
const MAX_OUTPUT_TOKENS = 16_384;

const STATUS_KEY = Symbol.for("lh.ollama.status");
function statusCell(): { current: OllamaStatus } {
	const g = globalThis as Record<symbol, { current: OllamaStatus } | undefined>;
	if (!g[STATUS_KEY]) g[STATUS_KEY] = { current: { configured: false, host: null, models: 0, error: null, checkedAt: null } };
	return g[STATUS_KEY];
}

/** The configured Ollama base URL (normalized), or undefined when unset.
 *  Reads process.env — the keys seam reflects auth.json there (and the
 *  fresh-user switch deletes env vars there), so this IS the live truth. */
export function ollamaHost(): string | undefined {
	const raw = process.env[OLLAMA_HOST_VAR];
	if (!raw) return undefined;
	return normalizeOllamaHost(raw) ?? undefined;
}

/** The last refresh's outcome, with `configured`/`host` always live. */
export function ollamaStatus(): OllamaStatus {
	const host = ollamaHost();
	const last = statusCell().current;
	return { ...last, configured: host !== undefined, host: host ?? null };
}

/** Test seam + `resetOllamaStatus` for fresh processes. */
export function resetOllamaStatus(): void {
	statusCell().current = { configured: false, host: null, models: 0, error: null, checkedAt: null };
}

async function getJson<T>(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
	const response = await fetch(url, { ...init, signal: AbortSignal.any(signals) });
	if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} → ${response.status}`);
	return (await response.json()) as T;
}

/** The `num_ctx N` line of a Modelfile's parameters, when set. */
export function parseNumCtx(parameters: string | undefined): number | undefined {
	const m = parameters?.match(/^\s*num_ctx\s+(\d+)\s*$/m);
	const n = m ? Number(m[1]) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The model's trained context length from model_info (`<arch>.context_length`). */
export function parseModelContextLength(info: Record<string, unknown> | undefined): number | undefined {
	if (!info) return undefined;
	for (const [key, value] of Object.entries(info)) {
		if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value;
	}
	return undefined;
}

/** The context window LearnHarness reports for a model (pure — exported
 *  for tests). Ollama applies, in order: the Modelfile's num_ctx, else the
 *  server's OLLAMA_CONTEXT_LENGTH, else its 4096 default — never the
 *  model's trained maximum. We cannot read the Ollama server's env, so the
 *  deployment passes the same OLLAMA_CONTEXT_LENGTH to LearnHarness (the
 *  compose file does) and that hint caps the reported window. Without a
 *  hint we assume Ollama's default rather than over-reporting: a window
 *  reported too LARGE would hide silent prompt truncation. */
export function ollamaContextWindow(show: OllamaShow, contextHint: number | undefined): number {
	const numCtx = parseNumCtx(show.parameters);
	const trained = parseModelContextLength(show.model_info);
	const window = numCtx ?? contextHint ?? OLLAMA_DEFAULT_CONTEXT;
	return trained ? Math.min(window, trained) : window;
}

function contextHint(): number | undefined {
	const raw = process.env[OLLAMA_CONTEXT_HINT_VAR];
	const n = raw ? Number(raw) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Project one Ollama model to pi-ai's Model shape (pure — exported for tests). */
export function ollamaModel(host: string, name: string, show: OllamaShow, hint: number | undefined): Model<"openai-completions"> {
	const caps = new Set(show.capabilities ?? []);
	const tools = caps.has("tools");
	const vision = caps.has("vision");
	const thinking = caps.has("thinking");
	// gpt-oss is the one family whose thinking takes low/medium/high through
	// the OpenAI-compatible `reasoning_effort`; other thinking models (qwen3,
	// deepseek-r1, …) think by default and take only a boolean, which the
	// OpenAI route cannot carry — they expose `off` alone and still think.
	const gptOss = /^gpt-oss/i.test(name) || show.details?.family === "gptoss";
	const contextWindow = ollamaContextWindow(show, hint);
	return {
		id: name,
		// The picker's label: tool-less models cannot run the harness (quiz,
		// plan_init, research are all tools) — say so where the user picks.
		name: tools ? name : `${name} (no tool support)`,
		api: "openai-completions",
		provider: OLLAMA_PROVIDER_ID,
		baseUrl: `${host}/v1`,
		input: vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.max(1024, Math.min(MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 2))),
		reasoning: thinking,
		...(thinking
			? {
					thinkingLevelMap: gptOss
						? { minimal: null, xhigh: null, max: null }
						: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
				}
			: {}),
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: thinking && gptOss,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
		},
	};
}

/** Fetch Ollama's chat-capable models (tags + per-model show). Embedding-
 *  only models (no `completion` capability) are skipped. */
export async function fetchOllamaModels(host: string, signal?: AbortSignal): Promise<Model<"openai-completions">[]> {
	const tags = await getJson<{ models?: { name?: string; model?: string }[] }>(`${host}/api/tags`, { method: "GET", headers: { accept: "application/json" } }, TAGS_TIMEOUT_MS, signal);
	const names = (tags.models ?? []).map((m) => m.name ?? m.model).filter((n): n is string => typeof n === "string" && n.length > 0);
	const hint = contextHint();
	const shown = await Promise.all(
		names.map(async (name) => {
			try {
				const show = await getJson<OllamaShow>(`${host}/api/show`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ model: name }) }, SHOW_TIMEOUT_MS, signal);
				const caps = show.capabilities ?? [];
				if (caps.length > 0 && !caps.includes("completion")) return null; // embedding model
				return ollamaModel(host, name, show, hint);
			} catch {
				// A model whose details cannot be read still lists — with
				// conservative defaults (text-only, no thinking, default window).
				return ollamaModel(host, name, {}, hint);
			}
		}),
	);
	return shown.filter((m): m is Model<"openai-completions"> => m !== null).sort((a, b) => a.id.localeCompare(b.id));
}

/** The pi-ai provider: keyless auth that resolves iff OLLAMA_HOST is set
 *  (the live host rides as auth.baseUrl, so a host change takes effect on
 *  the next request even for models fetched under the old one), an EMPTY
 *  static catalog, and the dynamic fetch above. */
export function ollamaProvider(): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: OLLAMA_PROVIDER_ID,
		name: "Ollama",
		baseUrl: `${ollamaHost() ?? "http://localhost:11434"}/v1`,
		auth: {
			apiKey: {
				name: "Ollama host",
				resolve: async ({ signal }) => {
					signal.throwIfAborted();
					const host = ollamaHost();
					if (!host) return undefined;
					// Ollama ignores Authorization; pi-ai requires a non-empty key.
					return { auth: { apiKey: "ollama", baseUrl: `${host}/v1` }, source: OLLAMA_HOST_VAR };
				},
			},
		},
		models: [],
		fetchModels: async (context) => {
			const host = ollamaHost();
			if (!host) return [];
			return fetchOllamaModels(host, context.signal);
		},
		api: openAICompletionsApi(),
	});
}

/** Refresh the Ollama catalog inside the given collection and record the
 *  outcome for the status surface. Unconfigured = an honest empty refresh
 *  (no network). Never throws: an unreachable server leaves the previous
 *  list in place (pi-ai's contract) and the error on the status. */
export async function refreshOllamaModels(models: Models): Promise<OllamaStatus> {
	const host = ollamaHost();
	const cell = statusCell();
	if (!host) {
		cell.current = { configured: false, host: null, models: 0, error: null, checkedAt: Date.now() };
		return ollamaStatus();
	}
	const result = await models.refresh({ providers: [OLLAMA_PROVIDER_ID], force: true, allowNetwork: true });
	const error = result.errors.get(OLLAMA_PROVIDER_ID);
	const count = models.getModels(OLLAMA_PROVIDER_ID).length;
	cell.current = {
		configured: true,
		host,
		models: count,
		error: error ? describeError(error) : null,
		checkedAt: Date.now(),
	};
	return ollamaStatus();
}

function describeError(error: Error): string {
	const cause = (error as { cause?: unknown }).cause;
	const inner = cause instanceof Error ? cause.message : undefined;
	const text = inner && inner !== error.message ? `${error.message}: ${inner}` : error.message;
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Ollama models, as pi-ai's catalog lookups see them (typed loosely —
 *  callers narrow with hasApi when they need the compat options). */
export function ollamaModels(models: Models): readonly Model<Api>[] {
	return models.getModels(OLLAMA_PROVIDER_ID);
}
