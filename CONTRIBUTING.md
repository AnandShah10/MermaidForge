# Contributing

## Setup

```bash
git clone https://github.com/AnandShah10/mermaidforge
cd mermaidforge
npm install
```

## Workflow

```bash
npm run compile   # type-check src/ (Node target) and src/webviews/media (browser target)
npm test          # vitest, tests/*.test.ts — pure logic only, no vscode/network dependency
npm run watch     # esbuild --watch, for use alongside F5
```

Press `F5` in VS Code to launch an Extension Development Host with your changes loaded.

## Where things go

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full picture. In short:

- Diagram-structure logic (parsing, linting, formatting, complexity, diff, refactoring) lives in `src/core/` and must not import `vscode`. This is what makes it unit-testable with vitest.
- Anything that touches the VS Code API (commands, panels, diagnostics, file watching) lives outside `src/core/` and is exercised manually (`F5`), not by the vitest suite.
- AI provider code lives in `src/ai/providers/<id>/` and must only be reached through the `AIProvider` interface (`src/ai/types.ts`) — never import a provider-specific type into `core/` or `commands/`.

## Adding a lint rule

1. Add a branch to `lintFlowchart()` in `src/core/linter/linter.ts`.
2. Add its severity setting to `mermaidForge.linter.rules.*` in `package.json`.
3. Wire the setting through in `src/workspace/diagnostics.ts`'s `lintDocument()`.
4. Add a test in `tests/linter.test.ts`.

## Adding an AI provider

1. Create `src/ai/providers/<id>/<id>Provider.ts` exporting a `create<Id>Provider(config, secrets)` returning an `AIProvider`. If the service speaks the OpenAI chat/completions protocol, configure `OpenAICompatibleProvider` (see `azureProvider.ts` for the minimal case) instead of reimplementing streaming/SSE parsing.
2. Add the id to `AIProviderId` in `src/ai/types.ts` and to `ALL_PROVIDER_IDS` / `PROVIDER_DISPLAY_NAMES` in `providerRegistry.ts`.
3. Add its settings (base URL, etc.) to `package.json`'s configuration schema.
4. API keys always go through `SecretsManager` (`src/utils/secrets.ts`) — never read a key from `vscode.workspace.getConfiguration()`.

## Code style

- TypeScript strict mode is on; keep it that way (no `any` suppression beyond what ESLint already allows).
- Prefer explicit `{ ok: true, ... } | { ok: false, reason: string }` result types over throwing for expected failure modes (see `core/refactoring/refactoring.ts`). Reserve exceptions for genuinely unexpected states.
- Every subsystem that can encounter a diagram type it doesn't structurally understand must say so explicitly (`{ supported: false, reason }`) rather than guessing or silently no-op-ing.

## Pull requests

Please include or update tests for any change to `src/core/` or `src/ai/service.ts` / `src/ai/contextBuilder.ts`. Changes to webview HTML/CSS or command wiring should note how you manually verified them (steps + what you saw), since that surface isn't covered by the automated suite yet.
