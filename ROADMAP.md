# Roadmap

Ideas, not promises. Anything shipped is described in the [README](./README.md); anything missing today is in [LIMITATIONS.md](./LIMITATIONS.md).

## Likely next
- **Deliberate Mermaid 12 upgrade** — re-verify element-id matching (presentation, comment badges) and the conformance suites.
- **Tests inside a real VS Code** (`@vscode/test-electron`) for commands and panels; today those are covered by manual checklists and a headless-browser smoke test of the webview.
- **CLI / CI mode** — lint, format check and export without VS Code.

## Maybe
- Comment badges for edges.
- Shared comments through a real sync backend (today: a JSON file you can commit).
- More refactorings for ER, requirement and mindmap diagrams where Mermaid syntax allows them.
- Deeper type resolution for call graphs.

## Not planned
- Pretending to support something we cannot verify. If a feature cannot be made real, it is documented as a limit instead.

Want something here sooner? Open an issue or a pull request.
