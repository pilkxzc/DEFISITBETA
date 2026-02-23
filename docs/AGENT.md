# AI Agent

> DEFIS ships a built-in autonomous browser agent powered by Claude (Anthropic) or Gemini (Google).

---

## How It Works

The agent receives a natural-language task, captures a screenshot of the current browser tab, and enters a tool-use loop:

```
User prompt
    │
    ▼
Agent (Claude / Gemini)
    │  Reasons about screenshot + DOM snapshot
    │  Decides which tool to call
    │
    ▼
Tool execution (in active BrowserView)
    │
    ▼
Result fed back to agent
    │
    └─ Repeat until task complete or max steps reached
```

Each step streams back to the UI as it happens — you see the agent's reasoning, tool calls, and results in real time.

---

## Configuration

Open **Settings → Agent** and set:

| Field | Description | Example |
|-------|-------------|---------|
| Provider | AI provider | `anthropic` |
| API Key | Provider API key | `sk-ant-...` |
| Model | Model name | `claude-sonnet-4-6` |
| Gemini API Key | Google AI key (if using Gemini) | `AIza...` |
| Gemini Model | Gemini model name | `gemini-2.0-flash` |

Settings are stored in the backend via `/api/config` and synced to all windows.

### Supported Models

**Anthropic (Claude)**

| Model | Speed | Intelligence | Best for |
|-------|-------|-------------|----------|
| `claude-opus-4-6` | Slower | Highest | Complex multi-step tasks |
| `claude-sonnet-4-6` | Fast | High | General use (recommended) |
| `claude-haiku-4-5` | Fastest | Good | Simple tasks, high volume |

**Google (Gemini)**

| Model | Notes |
|-------|-------|
| `gemini-2.0-flash` | Fast, good vision |
| `gemini-1.5-pro` | Larger context |

---

## Tool Reference

### `screenshot`

Captures the visible viewport of the active tab.

```json
{ "tool": "screenshot" }
```

- Output format: JPEG at 55% quality, max 1280 px wide
- Used automatically by the agent between steps to observe page state

---

### `navigate`

Loads a URL in the active tab and waits for the page to finish loading.

```json
{ "tool": "navigate", "url": "https://example.com" }
```

---

### `click`

Clicks an element. Accepts a CSS selector or pixel coordinates.

```json
{ "tool": "click", "selector": "#submit-button" }
{ "tool": "click", "x": 640, "y": 400 }
```

If the selector matches multiple elements, the first visible one is clicked.

---

### `type`

Types text into the currently focused element. Call `click` first to focus an input.

```json
{ "tool": "type", "text": "hello world" }
```

Special key support: `{enter}`, `{tab}`, `{escape}`, `{backspace}`

---

### `getDOM`

Returns a structured, readable DOM snapshot of the active tab (max 10 KB, depth 6).

```json
{ "tool": "getDOM" }
```

The output is a condensed HTML tree — tag names, `id`, `class`, `href`, `src`, `aria-label`, and text content (truncated at 80 chars per attribute). This is much cheaper than sending a full screenshot when the agent only needs structural information.

---

### `scroll`

Scrolls the page or a specific element.

```json
{ "tool": "scroll", "direction": "down", "amount": 500 }
{ "tool": "scroll", "selector": ".feed", "direction": "down", "amount": 300 }
```

`amount` is in pixels. `direction`: `up` | `down` | `left` | `right`

---

### `wait`

Waits for a CSS selector to appear in the DOM (polling every 200 ms, default timeout 10 s).

```json
{ "tool": "wait", "selector": ".results-container", "timeout": 5000 }
```

---

### `evaluate`

Executes arbitrary JavaScript in the page context and returns the serialised result.

```json
{ "tool": "evaluate", "script": "document.title" }
{ "tool": "evaluate", "script": "JSON.stringify(window.__APP_STATE__)" }
```

Use this for extracting structured data that's not visible in the DOM snapshot.

---

## Example Prompts

### Data extraction

> *"Go to news.ycombinator.com and return the titles, links, and point counts of the top 10 posts."*

### Form automation

> *"Open the contact form on example.com, fill in name='Test User', email='test@example.com', message='Hello', and submit it. Tell me what confirmation message appears."*

### Multi-step research

> *"Search Google for 'best Electron alternatives 2025', open the first three results, and give me a summary of each with pros and cons."*

### Login flow

> *"Log in to app.example.com with username 'user@test.com' and password 'secret123'. Once logged in, navigate to the Settings page and tell me what subscription plan is shown."*

---

## Resource Efficiency

The agent is tuned to minimise token consumption:

| Setting | Value | Why |
|---------|-------|-----|
| Screenshot format | JPEG 55% | ~70% smaller than PNG |
| Screenshot max width | 1280 px | Sufficient detail |
| DOM snapshot limit | 10 000 chars | Enough for most pages |
| DOM depth | 6 levels | Captures most UI structure |
| Attribute truncation | 80 chars | Preserves meaningful data |

---

## Limitations

- The agent operates in the currently active tab only
- JavaScript-heavy SPAs may require `wait` calls between navigation steps
- File downloads and native OS dialogs cannot be interacted with
- CAPTCHA solving is not supported
- The agent does not persist state between separate task invocations (each task starts fresh)
