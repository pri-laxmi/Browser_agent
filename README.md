# Browser Pilot

Browser Pilot connects a React shell to an installed, headed Chrome session, streams the active page into the app, and runs bounded browser tasks through an OpenAI-compatible chat-completions model.

## Requirements

- Node.js 22 or newer and npm
- Google Chrome installed on the machine running the server

The server launches Chrome with a persistent profile at `server/.browser-profile/`. Logins and browser data stay on that machine; the profile is ignored by Git. Run only one Browser Pilot server against this profile at a time.

Configure a model from **Settings** in the app. Groq uses `https://api.groq.com/openai/v1`, a supported model name (the default is `llama-3.3-70b-versatile`), and a Groq API key. OpenRouter uses `https://openrouter.ai/api/v1`, a model name, and an OpenRouter API key. Local Ollama or LM Studio uses its OpenAI-compatible `/v1` URL, model name, and no key. Model settings and task history are stored in the git-ignored `server/.browser-pilot-settings.json` and `server/.browser-pilot-history.json` files.

## Start Developing

```sh
git clone <repository-url>
cd Browser_agent
npm install
npm install --prefix server
npm install --prefix web
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The server listens on port `3001`; `GET http://localhost:3001/health` reports its status. Stop both development processes with `Ctrl+C`.

Run production TypeScript and frontend builds with:

```sh
npm run build
```

## Architecture

```text
Browser Pilot workspace
├── server/   Express, WebSocket, Playwright, persistent Chrome
└── web/      React, Vite, TypeScript, Tailwind CSS
```

- The root `package.json` runs the server and Vite concurrently with `npm run dev`.
- `server/src/index.ts` starts Express and a WebSocket server on the same HTTP server. Playwright launches the installed Chrome channel in headed mode, using the project-local persistent profile.
- The server terminal prints timestamped JSON diagnostics for task steps, page inspections, actions, navigation, browser console/page errors, and failed requests. Typed text and API keys are not included in action logs.
- Model requests automatically retry once after a rate-limit response, waiting at least 22 seconds or the provider's longer retry delay. Stopping the task cancels the wait.
- Browser observations and recent action history are bounded before being sent to the model to avoid oversized prompts on long shopping/search pages; model-request logs report message count and prompt character count without printing prompt contents.
- Routine browsing, including navigation, search, scrolling, waiting, and reading page text, does not require approval. Approval is reserved for runtime-detected consequential controls or fields such as payment, purchase, subscription, deletion, account removal, posting, and password changes; unrelated words elsewhere on the page do not trigger it.
- The server follows newly opened tabs and streams the newest active page as JPEG frames about every 400 ms (roughly 2.5 frames per second), together with the current URL, title, and capture time. Frames are sent only while at least one WebSocket client is connected.
- `web/src/BrowserPilot.tsx` renders the app shell and live frame. It reconnects to the WebSocket with increasing delays when the connection drops and shows connecting, connected, disconnected, and error states.
- `server/src/agent.ts` uses plain `fetch` chat-completion requests with one browser-action tool per turn. Each action requires a model-provided safe/critical classification and reason; runtime keyword checks independently inspect the target and observed page text. Critical actions wait for explicit approval in the app and are never auto-approved.
- The agent checks for existing account/session indicators before requesting sign-in, never handles credentials, and pauses for the user to sign in directly in Chrome. Non-sensitive questions use the same interaction card with a reply field. All pending interactions can be stopped.
- Express exposes `/api/settings` and `/api/settings/test` for model setup, `/api/tasks` and `/api/tasks/:id` for running and persisted task history, and `/api/tasks/:id/stop` to halt a run. User questions and sign-in continuation use `/api/tasks/:id/respond`; safety decisions use `/api/tasks/:id/approve`.
- Vite proxies `/api` to the server during development; live browser frames and task events use the existing WebSocket.

## WebSocket Messages

Connect to `ws://localhost:3001`. The server sends status messages and snapshots shaped like:

```json
{"type":"status","status":"connected"}
```

```json
{"type":"snapshot","url":"https://example.com/","title":"Example Domain","image":"<base64 JPEG>","capturedAt":1790944142640}
```

To navigate the active browser tab, send:

```json
{"type":"navigate","url":"https://example.com/"}
```

Only HTTP and HTTPS navigation URLs are accepted. The page title and URL appear in the stream metadata and browser toolbar.

## Server API

- `GET /health` reports browser startup state.
- `GET /api/settings` returns the configured provider and model without revealing the saved API key. `PUT /api/settings` saves settings; `POST /api/settings/test` makes a small completion request and returns a readable result.
- `POST /api/tasks` accepts `{ "task": "..." }` and returns a task ID. Progress and completion are streamed as `agent-event` and `task-finished` WebSocket messages.
- `GET /api/tasks` lists recent task summaries. `GET /api/tasks/:id` returns a task's events and action results. `POST /api/tasks/:id/stop` stops a run, including while awaiting user input or approval.
- `POST /api/tasks/:id/respond` accepts `{ "answer": "..." }` for a non-sensitive question or `{ "answer": "Continue" }` after the user signs in directly in Chrome. `POST /api/tasks/:id/approve` accepts `{ "approved": true }` or `{ "approved": false }`; denial skips the action and informs the model.

The browser-control WebSocket currently has no authentication, so keep the server on a trusted development machine and do not expose port `3001` to an untrusted network.