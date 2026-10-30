<div align="center">

<img src="resources/icon.png" alt="MermaidForge logo" width="96" />

# MermaidForge — AI Mermaid Studio

**Write, preview, format, lint, refactor, present and export Mermaid diagrams in VS Code — and generate them from your code.**
AI is optional: everything except the AI commands works with no provider and no network.

[![License: MIT](https://img.shields.io/github/license/AnandShah10/MermaidForge?logo=github)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AnandShah10/MermaidForge?logo=github)](https://github.com/AnandShah10/MermaidForge/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/AnandShah10/MermaidForge?logo=github)](https://github.com/AnandShah10/MermaidForge/issues)
[![Last commit](https://img.shields.io/github/last-commit/AnandShah10/MermaidForge?logo=github)](https://github.com/AnandShah10/MermaidForge/commits/main)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen?logo=github)](./CONTRIBUTING.md)

</div>

---

## Why MermaidForge

Mermaid is great until a diagram grows: hand-indenting, hunting a broken arrow, keeping a diagram in step with the code, exporting a crisp PDF for a slide. MermaidForge puts the whole loop inside VS Code, with deterministic tools first and AI as an optional extra that never writes to your files without a diff you approve.

## Highlights

| | |
|---|---|
| **Four ways to look at a diagram** | Side-by-side **Preview**, full-width **Viewer** (the diagram *instead of* the code, with **← Return to code**), step-by-step **Presentation**, and **Studio** (diagram + AI chat + complexity + problems + comments). One toolbar everywhere: Viewer · Present · Studio · Export ▾ · Comment · − Fit +. |
| **Format** | Whole document or just a selection, in `.mmd` files and in Markdown ```` ```mermaid ```` blocks. Flowcharts are re-rendered from the parsed model; other kinds are re-indented by block nesting, changing only whitespace. |
| **Lint** | Real diagnostics in the Problems panel for 19 diagram types, configurable per rule. |
| **Refactor** | Rename an id everywhere, remove unused items, extract items into a group — driven by the parsed model, not find/replace. |
| **Complexity** | Nodes, edges, density, cycles, longest path, a 0–10 score and a plain-language recommendation. |
| **Semantic Git diff** | "What changed" in nodes and edges against `HEAD`, not just text lines. |
| **Export** | SVG, PNG and **vector PDF** (real paths, selectable text) with no headless browser. Exports use a light theme on white by default, whatever your editor theme. |
| **Comments** | Comment on a node, an edge or the whole diagram; commented nodes get a count badge. Stored as plain JSON you can commit. |
| **Code → Mermaid** | Import graphs, class diagrams, call graphs and **web-route maps** from TypeScript/JavaScript, Python, Rust, C/C++, Java, C#, Go, Kotlin, Swift, PHP and Ruby; plus React component trees and a **Git history timeline**. |
| **Draw.io import** | Convert a `.drawio` export (compressed or not) to a Mermaid flowchart. |
| **AI (optional)** | Generate, explain, fix, improve, modify and ask about diagrams with OpenAI, Azure OpenAI, Anthropic, Google Gemini, Ollama (fully local) or any OpenAI-compatible server. Every change goes through a VS Code diff first. |

Full details: [FEATURES.md](./FEATURES.md) · What is *not* covered: [LIMITATIONS.md](./LIMITATIONS.md)

## Getting started

1. Install **MermaidForge — AI Mermaid Studio** from the Extensions view (or `code --install-extension mermaidforge-0.1.0.vsix`).
2. Open a `.mmd` / `.mermaid` file, or a Markdown file with a ```` ```mermaid ```` block.
3. Click the **Viewer** (eye) icon in the editor title bar, or run **Mermaid: Open Preview** from the Command Palette (`Ctrl/Cmd+Shift+P`).
4. Use the toolbar: **Present**, **Studio**, **Export ▾**, **Comment**. **← Return to code** brings the source back.
5. Optional: run **AI Mermaid: Configure Provider** to enable the AI commands.

Requires VS Code **1.85** or newer. The Mermaid renderer is bundled, so previews work offline.

## Commands

Open the Command Palette and type `Mermaid:` (or `AI Mermaid:`).

| Command | What it does |
|---|---|
| `Mermaid: Open Preview (side by side)` | Live preview that follows the active editor |
| `Mermaid: Open Viewer (diagram instead of code)` | Diagram in the editor's own column |
| `Mermaid: Return to Code` | Close the viewer/presentation, show the source |
| `Mermaid: Presentation Mode` | Step through the diagram, rest dimmed |
| `Mermaid: Open Studio` | Diagram + AI chat + complexity + problems + comments |
| `Mermaid: Format Document` / `Format Selection` | Format a file, a block, or selected lines |
| `Mermaid: Lint Diagram` | Force a lint pass (also automatic) |
| `Mermaid: Analyze Complexity` | Complexity report |
| `Mermaid: Export Diagram` | SVG / PNG / PDF |
| `Mermaid: Compare With Git (HEAD)` | Semantic diff vs the last commit |
| `Mermaid: Rename Node Everywhere` · `Remove Unused Nodes` · `Extract Subgraph From Selection` | Refactoring |
| `Mermaid: Add Comment` | Comment on a node, edge or the diagram |
| `Mermaid: Navigate Diagrams (Refresh Index)` | Rescan the workspace diagram tree |
| `Mermaid: Convert Draw.io to Mermaid` | Import a Draw.io export |
| `Mermaid: Generate From Code` | Reverse-engineer a codebase into a diagram |
| `Mermaid: Generate Timeline From Git History` | Commit history → Mermaid timeline |
| `AI Mermaid: Generate / Explain / Improve / Fix / Modify / Ask / Review Architecture` | AI operations, diff-reviewed |
| `AI Mermaid: Configure Provider` | Set an API key and default provider |

## AI providers

| Provider | Setup |
|---|---|
| OpenAI · Anthropic · Google Gemini | `AI Mermaid: Configure Provider` → paste API key |
| Azure OpenAI | Set `mermaidForge.ai.providers.azure.endpoint` / `.deployment` / `.apiVersion`, then add the key |
| Ollama (local) | Run `ollama serve` (default `http://localhost:11434`); no key |
| Custom (OpenAI-compatible) | Set `mermaidForge.ai.providers.custom.baseUrl` — covers Mistral, Groq, Together, OpenRouter, LM Studio and most self-hosted servers |

Keys live only in VS Code's `SecretStorage`: never in `settings.json`, never logged.

## Settings

All settings are under `mermaidForge.*` (Settings UI → search "MermaidForge"). The ones you are most likely to change:

| Setting | Default | |
|---|---|---|
| `preview.theme` | `auto` | `auto` follows VS Code (dark theme in dark VS Code); or `default`, `dark`, `forest`, `neutral`, `base` |
| `preview.background` | `auto` | Editor background in views, white in exports; or any CSS colour / `transparent` |
| `export.scale` | `2` | PNG scale factor |
| `formatter.formatOnSave` | `false` | Format `.mmd` files on save |
| `formatter.indentSize` | `2` | Spaces per indent level |
| `linter.rules.*` | varies | `off` / `warning` / `error` per rule |
| `complexity.threshold` | `7` | Score above which a split is recommended |
| `ai.defaultProvider` | `anthropic` | Provider used when none is specified |
| `ai.sendSourceContext` | `true` | Needed for explain/fix/improve/modify/review |
| `comments.authorName` | OS user | Name on your comments |

## Privacy & security

- API keys: `SecretStorage` only.
- The only data sent to an AI provider is the current diagram's Mermaid source (when `ai.sendSourceContext` is on) plus locally computed lint/complexity summaries. No workspace file is sent by any shipped command.
- No telemetry. Ollama gives you a fully local option.
- Comments are written to `.mermaidforge/comments.json` in your workspace and nowhere else.

See [SECURITY.md](./SECURITY.md) to report a vulnerability.

## Known limits (short list)

MermaidForge says what it can't do instead of faking it. Highlights — the full list is in [LIMITATIONS.md](./LIMITATIONS.md):

- Code → Mermaid analyzers are syntax-only and name-based; call graphs are approximate.
- PDF export is vector but uses Helvetica, and skips gradients, filters, clip paths and images; use SVG for lossless output.
- Presentation and comment badges rely on Mermaid's element ids and were verified against the bundled Mermaid 11.17.2.
- Comments are a local JSON file, not real-time collaboration.
- Format Selection on a flowchart reformats the whole diagram.

## Contributing

Issues and pull requests are welcome — read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md). Architecture notes are in [ARCHITECTURE.md](./ARCHITECTURE.md), plans in [ROADMAP.md](./ROADMAP.md), help in [SUPPORT.md](./SUPPORT.md), and releases in the [CHANGELOG](./CHANGELOG.md).

```bash
git clone https://github.com/AnandShah10/mermaidforge && cd mermaidforge
npm ci
npm run compile && npm test && npm run build
npm run package        # → .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

## License

[MIT](./LICENSE) © Anand Shah

---

<div align="center">

**Made with ❤️ by [Anand Shah](https://github.com/AnandShah10) for the developer community.**

</div>
