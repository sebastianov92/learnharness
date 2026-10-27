<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning — server edition.</strong></p>

<p align="center">
  <a href="#run-it-on-a-server-docker">Run with Docker</a> ·
  <a href="#offline-with-ollama">Offline with Ollama</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/sebastianov92/learnharness/issues">Issues</a>
</p>

> **This fork** ([sebastianov92/learnharness](https://github.com/sebastianov92/learnharness)) turns [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness) into a **self-hosted service**: it ships as a Docker image with a `docker-compose.yml`, adds **Ollama** as a provider so it can run fully offline on local models, and removes the macOS / Windows / Linux desktop apps. Everything else — the teaching method, the knowledge graph, practice, the 30+ cloud providers — is unchanged.

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Run it on a server (Docker)

Requirements: Docker with Compose on any Linux/macOS host (x64 or arm64). The image builds from source; no registry account is needed.

```bash
git clone https://github.com/sebastianov92/learnharness.git
cd learnharness
docker compose up -d --build
```

Open `http://<your-server>:3000`. The first run asks for a provider: paste a cloud API key **or** use the bundled Ollama (see below), then pick your three models and start a session.

What the compose file starts:

| Service | What it is | Persisted in |
|---|---|---|
| `learnharness` | the app (Next.js standalone server, port 3000) | volume `learnharness-data` → `/data`: chats, graph, settings, saved keys |
| `ollama` | an Ollama server for local models | volume `ollama-models`: pulled weights |

Useful variables (set them in `docker-compose.yml` under `learnharness.environment`):

| Variable | Purpose |
|---|---|
| `OLLAMA_HOST` | Ollama's address (`http://ollama:11434` for the bundled service). Unset it to configure Ollama from the UI instead, or point it at an Ollama you already run. |
| `OLLAMA_CONTEXT_LENGTH` | Mirror of the Ollama service's context length (the compose file uses 32768 for both) so the context meter is honest. |
| `LH_ACCESS_PASSWORD` (+ `LH_ACCESS_USER`) | Turns on HTTP Basic auth for every page and API call. **Set it before exposing the port beyond localhost**, and put TLS (a reverse proxy) in front. |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, … | Any provider key can be given as an environment variable instead of the UI; environment values win and show read-only in Settings. |

Operations:

```bash
docker compose logs -f learnharness     # server log
docker compose pull ollama && docker compose up -d   # update Ollama
git pull && docker compose up -d --build             # update LearnHarness
docker run --rm -v learnharness-data:/data -v "$PWD":/backup debian tar czf /backup/learnharness-data.tgz -C /data .   # backup
```

Without Compose: `docker build -t learnharness .` then `docker run -d -p 3000:3000 -v learnharness-data:/data learnharness`.

## Offline with Ollama

[Ollama](https://ollama.com) serves open models on your own hardware. LearnHarness lists **every chat model your Ollama server has pulled** in its model pickers, at $0, and talks to it over Ollama's OpenAI-compatible API. Nothing leaves the machine unless you also enable web research or dictation.

```bash
docker compose exec ollama ollama pull qwen3:8b        # a strong general model with tool support
docker compose exec ollama ollama pull qwen2.5vl:7b    # a vision model for the "vision" slot
```

Then in LearnHarness: **Settings → Providers → Local models** shows the Ollama address and how many models it found; the model pickers list them under the provider `ollama`. The three slots (strong / cheap / vision) can all be local, or you can mix local and cloud models freely.

What to know:

- **Tools are required.** The teacher works through tools (quizzes, planning, research). Models without tool support are listed with a "(no tool support)" suffix; pick ones that have it (Qwen 3, Llama 3.1+, Mistral, GPT-OSS, …).
- **Context length matters.** Ollama defaults to 4096 tokens, far too small for a teaching agent. The compose file sets `OLLAMA_CONTEXT_LENGTH=32768` on both services; if you run your own Ollama, set it there and mirror the value on LearnHarness.
- **Thinking models** (Qwen 3, DeepSeek-R1, GPT-OSS) work; GPT-OSS additionally exposes low/medium/high thinking levels.
- **Hardware.** CPU inference works but is slow; a GPU makes it pleasant. The compose file has a commented NVIDIA block.
- **Without Docker,** install Ollama on the host and enter its address (`http://localhost:11434`) in Settings → Providers → Local models.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. You pay your providers for usage — or nothing, with Ollama; a live cost meter shows model costs.
- **Your server.** Your chats, graph, settings, and API keys live in the `/data` volume on your server. Learning records are plain files you can inspect and back up.
- **External services.** Cloud models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. With Ollama, model requests stay on your network.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # deterministic, no LLM, no network
npm run build:server   # the standalone payload + the smoke gates the Docker build runs
```

See the [development guide](docs/development.md) and [architecture](docs/architecture.md).

Questions, bug reports, and feature requests for this fork: [GitHub Issues](https://github.com/sebastianov92/learnharness/issues). Upstream: [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness).

## License

[AGPL-3.0](LICENSE)

Upstream's promise carries over: free and open forever. This fork adds nothing you pay for — it only changes where it runs.
