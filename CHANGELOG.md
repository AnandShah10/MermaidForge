# Changelog

## 0.1.2

- Fixed: **Format Selection** did nothing useful — the selected text was formatted on its own, without the diagram around it, so indentation was wrong and the diagram header was misread; it also didn't work in Markdown. It now formats exactly the selected lines using the whole diagram's context (flowcharts reformat the whole diagram and say so), works on the ```` ```mermaid ```` block under the cursor in Markdown, and VS Code's own "Format Selection" works in `.mmd` files (range formatting provider)
- Fixed: some diagrams opened off-centre or partly outside the view (the pan/zoom transform dropped the centring offset); diagrams are now centred on open, on Fit, after zoom, and zoom keeps the point under the cursor fixed
- Docs: marketplace-ready README with GitHub-only badges; added FEATURES, LIMITATIONS, ROADMAP, SUPPORT, SECURITY, CODE_OF_CONDUCT, GitHub issue/PR templates and a CI workflow
- UI: toolbar (Viewer, Present, Studio, Export ▾ SVG/PNG/PDF, Comment, zoom/Fit) in the Preview, Viewer, Presentation and Studio views and Viewer/Present/Studio/Export buttons in the editor title bar; new **Mermaid Viewer** (diagram instead of code) with **Return to code**; Presentation mode now has its own panel title, panel and Return to code; fit-to-view; comment count badges on nodes plus a comment list
- Fixed: "Failed to rasterize SVG for PNG export" — the webview's Content-Security-Policy did not allow the `blob:` image the exporter loaded; PNG now goes through a data URL with an explicit size
- Fixed: a Mermaid syntax-error graphic (and our red banner) stayed on screen after the source was fixed — errors are detected with `mermaid.parse`, Mermaid's own error drawing is suppressed, and leftover elements are removed after each render
- Changed: `preview.theme` and `preview.background` default to `auto` (dark theme/editor background in dark VS Code themes; exports stay light on white). Studio no longer shows a white canvas in dark themes

## 0.1.1

- Fixed: ASP.NET minimal-API apps built in one chained expression (`WebApplication.CreateBuilder(args).Build()`) were not detected; Python call graphs now read one-line `def f(): ...` bodies and type `self.x = x` from annotated parameters; C++ `Circle c(2);` locals are typed
- Added a manual test workspace (see TESTING.md in it)
- Rust routers kept in struct fields are followed by field name
- Route loops over inline literal collections are unrolled for Go, Rust, Java, C#, Kotlin and PHP (`common/loopUnroll.ts`)
- Rails `shallow`, `draw :file` (inlined into the surrounding scope) and `devise_for`; Python route registration in loops over literal lists is unrolled
- Gap fixes: Spring functional endpoints (Java builder/classic/`nest`, Kotlin `router { }`/`coRouter { }`), Symfony Doctrine `@Route` docblocks, ASP.NET conventional routing (`MapControllerRoute` / `MapDefaultControllerRoute`), Rails brace blocks, irregular plurals and `on: :collection/:member`, Fastify/Koa/Hapi route loops over literal arrays, and TypeScript generic substitution (`Box<Repo>`)
- Fixed: C# attributes with a lone string argument (`[Route("api/x")]`, `[HttpGet("x")]`) lost the string when the argument list was split, so class route prefixes were dropped
- New languages: **Kotlin** (Spring and Ktor routes), **Swift** (Vapor routes), **PHP** (Laravel and Symfony `#[Route]` routes) and **Ruby** (Rails `routes.rb` and Sinatra routes), each with import graph, class diagram and call graph; validated on real repositories (Ktor samples, PetClinic Kotlin, Vapor, Alamofire, Laravel, Symfony demo, Koel, Sinatra, Mastodon, Rails RealWorld)
- Express route maps follow loops over literal arrays and `fs.readdirSync(dir).forEach(...)` directory scans (heuristic: every scanned file in the folder is treated as loaded); everything else in loops is still skipped
- TypeScript call graphs resolve receivers through unions with null/undefined, arrays/sets/maps (for…of, `forEach`/`map` callbacks, indexing, `Map.get`), destructuring, interface/type-alias members and `as` casts; the other languages resolve loop variables over typed collections; Java parameter types are now used
- Routes: Fastify `fastify-plugin` `fp()` wrappers, `koa-mount`, NestJS `RouterModule.register` (with nested children) and Hapi `server.route` are now followed; routers in loops/macros, directory scanning, and Python/Rust/Java/C# class fields remain unsupported and are documented as such
- Call graphs: receiver types now also come from declared return types (`-> Repo`, `*Repo`, `Task<Repo>`, `Promise<Repo>`, TypeScript `return new X()`), including `make().save()` chains; interface/trait/base-class receivers get dotted edges to the implementers that define the method (Go interfaces are matched structurally; fan-out above 12 is dropped)
- Hapi plugins: `register({ plugin, routes: { prefix } })`, plugin objects with `register`, arrays and imported plugin modules; Python routers held on class instances (`self.router`, `api.router`) are followed
- Call graphs resolve `obj.method()` when the receiver's type is declared locally (typed parameters, fields, `new Foo()` locals; TypeScript follows `extends`) in TypeScript, Python, Rust, Go, Java, C# and C++, and no longer link a call to an import that a local or parameter shadows
- Semantic diff covers pie, journey, timeline, gitGraph, quadrant, xychart and packet diagrams, and the command offers a detailed report
- Per-item comment targets for every diagram kind, not only flowcharts
- Extension icon
- Routes: Fastify (register + prefix, nested/imported plugins, `route({..})`, `@fastify/autoload` with a literal `dir`), Koa (`@koa/router` / `koa-router`) and NestJS (`@Controller` + method decorators, `setGlobalPrefix` scoped per project) are now mapped; routers kept in Go struct fields (named or embedded) and in TypeScript/JavaScript class members are followed
- Presentation mode now covers sequence diagrams (one message per step) and sankey diagrams (one link per step), matched by document order and verified against the model
- Extract into a group now works for state diagrams (composite state) and block diagrams (`block:Id … end`); the remaining kinds (ER, requirement, mindmap) have no grouping syntax and say so
- Formatter re-indents sequence, class, ER, state, requirement, C4, block, gantt, journey and timeline diagrams by block nesting, changing only leading/trailing whitespace; flowchart labels containing `"` are written as `#quot;`; multi-line `%%{init}%%` directives no longer stop the diagram type being detected
- Rename leaves inline flowchart edge text (`A -- text --> B`, `==`, `-.`) and `id>asymmetric]` shape text alone

- Code analyzers validated against 26 real repositories (`npm run realrepo -- <dir>`); fixed what that found: flowchart labels with `"` no longer break Mermaid (`#quot;`), class diagrams from Rust `impl` blocks on non-nominal types, multi-line `where` clauses, members with braces/quotes/`<` before `(`
- Route maps follow routers passed to functions and returned from factories — Go (also closures such as chi `r.Route`, import aliases, per-function scoping), Express (also aliased `express`/`Router` imports, `require('./routes')(app)`) and Python (`register_routes(app)`, `app = create_app()`)
- Rust routes: poem, tide and warp (filter composition evaluated); tide `nest({ .. api })` blocks
- Call graphs prefer same-file, then imported-file functions; unresolved name matches are marked ambiguous, drawn dotted, and counted in the command's note. TypeScript/JavaScript call graphs follow named/aliased/default/namespace/`require` imports, `module.exports`, re-exports and `@/` aliases. On the real repositories this removed 29% of call edges that plain name matching had guessed

- stateDiagram `[*]` is now scoped per composite state and concurrent region; start→end flows no longer look like cycles
- gantt dates are interpreted (`dateFormat` tokens, durations, excludes/weekend, after/until); new lint rules for invalid/rolled dates, invalid durations, end-before-start and dependency cycles, with severities checked against real Mermaid; gantt now supports semantic diff and complexity via the graph projection
- Styling directives modelled for requirement, block, quadrant and C4 (`classDef`/`class`/`style`/`:::`, `Update*Style`) with new `styleUnknownClass` / `styleUnknownTarget` / `styleUnusedClass` rules; quadrant unknown class downgraded from error to warning (Mermaid ignores it); remove-unused cleans style references
- New checks: `npm run gantt-conformance`, `npm run styling-conformance`

- **Fixed a regression from the Mermaid 11 upgrade:** element ids now carry a per-render prefix, which had silently broken click-to-source and flowchart presentation mode; both fixed and now covered by `scripts/presentation-smoke.mjs` against a real render
- Presentation mode for class, ER, state, requirement, C4, architecture, block and mindmap diagrams
- Remove-unused for class, ER, state, requirement, C4 and architecture diagrams; extract-into-group for class (`namespace`), C4 (`Boundary`) and architecture (`group`) diagrams — every output is checked against real Mermaid by `scripts/refactor-conformance.mjs`
- Upgraded the bundled Mermaid from 10.9 to 11.17: 10.9 could not render `packet-beta` or `architecture-beta` at all
- Parsers checked against real Mermaid (63-sample corpus, `npm run conformance`); fixes: architecture edge titles `-[title]-`, `{group}` edge modifier rule, block-diagram shape text must be quoted
- Rename now works for class, ER, state and sequence diagrams and is label-aware for flowcharts too (it used to rewrite label text containing the id)
- Rust web routes: actix-web, axum and Rocket (scopes, resources, nest/merge, `routes![]`, attribute handlers)
- Test harness scripts: `scripts/conformance.mjs`, `webview-smoke.mjs`, `pdf-e2e.mjs` (need Playwright + Chromium; not part of `npm test`)
- Semantic diff and complexity analysis now work on class, ER, state, mindmap, sankey, requirement, block, architecture and C4 diagrams (diff also on sequence) via a shared graph projection
- Fixed block-diagram parser rejecting a bare id at the end of a row (`a b c`)
- Structural parsers and linting for sankey, quadrantChart, xychart, packet, requirementDiagram, block, architecture and C4 (previously syntax-only light model; the light model now applies only to unrecognised headers)

## 0.1.0 — Initial release

**Foundation**
- Mermaid language support (`.mmd`/`.mermaid`, syntax highlighting, folding on subgraph/end)
- Structural flowchart/graph parser producing an intermediate graph model (nodes, edges, subgraphs, classDef/class, styles, comments)
- Diagram-type detection for all listed Mermaid diagram kinds, with a lightweight fallback model for types without a dedicated structural parser
- Live preview (debounced, pan/zoom, click-to-source for flowcharts, graceful error display)
- Prettier-style formatter (semantic for flowcharts, idempotent; whitespace-only fallback for other types), with format-on-save
- Linter with configurable rules reporting into the Problems panel

**Studio**
- MermaidForge Studio panel: live canvas + AI chat + complexity + problems in one view
- Diagram navigator (Explorer sidebar tree of every diagram in the workspace, incrementally indexed via file watchers)
- Deterministic complexity analyzer (nodes/edges/density/cycles/longest path/fan-in/out, explainable 0–10 score)
- Semantic diff (node/edge/subgraph level, not line-based) plus Git HEAD comparison
- Refactoring: rename node everywhere, remove unused nodes, extract subgraph
- SVG/PNG/PDF export (PDF is vector-first with a raster fallback — see below)
- Draw.io / diagrams.net → Mermaid converter for both uncompressed and (Draw.io's default) compressed XML exports (shapes + connectors → flowchart, with clear warnings for anything skipped) — compressed diagrams are decompressed with Node's built-in `zlib.inflateRawSync`, no new dependency needed
- Structural sequenceDiagram parser (participants/actors with aliases, messages with arrow-style tracking, notes, loop/alt/opt/par/critical/rect/break blocks) with real linting (isolated participants, unclosed blocks, duplicate declarations, long message text) — complexity/diff/refactoring remain flowchart-only, deliberately
- Structural classDiagram parser (class bodies with members, visibility/method detection, stereotypes via both `<<interface>>` syntaxes, all seven relationship types with cardinality and label extraction) with matching real linting (isolated classes, unclosed bodies, duplicate members) — same complexity/diff/refactoring boundary as sequenceDiagram
- Structural erDiagram parser (entity attribute bodies with typed attributes and PK/FK/UK key markers, relationships with crow's-foot cardinality tokens and identifying/non-identifying line style) with matching real linting (isolated entities, unclosed bodies, duplicate attributes) — same complexity/diff/refactoring boundary as sequenceDiagram and classDiagram
- Structural stateDiagram/stateDiagram-v2 parser (simple states, arbitrarily-nested composite states, choice/fork/join pseudostates, the shared `[*]` initial/final pseudostate, inline and multi-line notes) with matching real linting (isolated states, duplicate transitions, empty composite states, unclosed composites/notes) — same complexity/diff/refactoring boundary as the other three non-flowchart structural types, plus its own documented `[*]`-scoping limitation
- Structural pie chart parser (title, `showData`, slices) with linting for duplicate slice labels and non-positive values
- Structural user-journey parser (title, sections, tasks with score and actors) with linting for duplicate tasks within a section and tasks missing actors — task names are checked per-section rather than globally, since Mermaid itself doesn't treat them as unique ids
- Structural gitGraph parser (commits with ancestry tracking including merge commits' two parents, branches, cherry-picks, `id`/`tag`/`type` options) with matching real linting; most structural errors (unknown branch/commit references, duplicate branches/ids) are treated as parse-level errors, plus a lint rule for branches with no commits
- Structural timeline parser (title, sections, periods with one or more events via continuation lines) with linting for duplicate period labels within a section
- Structural mindmap parser — the one diagram type in the project where nesting is indentation-driven rather than delimiter-driven; handles all shape delimiters, the canonical `root((label))` leading-identifier form, `::icon(...)`/`:::className` attachments, and recovers gracefully (one warning, not a cascade) from a mis-indented second root — with linting for empty labels and duplicate sibling labels
- Structural gantt parser (title, dateFormat, sections, tasks with status keywords, id, start/after-dependency, and duration fields) — deliberately does not interpret dates or compute duration arithmetic, modeling only the raw fields and the `after`-dependency structure, which is what its linting (duplicate task ids, self-referential or unknown "after" targets) actually needs
- Git History Timeline (`Mermaid: Generate Timeline From Git History`) — turns commit history into a Mermaid timeline, grouped by year or month, via VS Code's Git extension API (the same one Source Control uses). Capped at 500 commits. The commit-grouping/rendering logic is a pure, unit-tested function; generated output is round-tripped through this project's own timeline parser to confirm validity
- PDF export — hand-written SVG→PDF converter and PDF writer (Node's built-in `zlib` only, no headless browser or PDF library): vector paths/shapes/arrowhead markers/opacity/dashes/transforms and selectable Helvetica text, with the webview inlining computed styles first. Falls back to a raster PDF (PNG decoder + image XObject) when conversion is impossible. Documented limits: no gradients, filters, clip paths, images, `<use>`; Helvetica only; HTML labels flattened to single lines.
- Presentation mode — step through a flowchart with progressive, dimming-based node/edge reveal that never re-lays out the diagram; steps from author-written `%% step:` comments or auto-generated one-per-node. DOM-manipulation logic verified with `jsdom`, not just asserted.
- Diagram comments — attach a comment to a node, edge, or whole diagram via `Mermaid: Add Comment` or Studio's Comments tab; stored as a git-committable `.mermaidforge/comments.json`, behind a `CommentBackend` interface a future GitHub/GitLab/Azure DevOps sync layer can implement without touching calling code. Core add/update/delete/list logic unit-tested against an in-memory store.
- Code → Mermaid (`Mermaid: Generate From Code`) — import/package/include graphs, class/type diagrams, name-based call graphs, React component trees and web-route maps for TypeScript/JavaScript (TS compiler API), and for Python (Flask/Quart/FastAPI/Django routes), Rust, C/C++, Java (Spring/JAX-RS routes), C# (ASP.NET Core routes) and Go (net/http, gin, echo, fiber, chi, gorilla/mux routes) via hand-written lexical scanners over comment/string-blanked text. Syntax-only; limits in README. Generated graphs over 400 edges are flagged; the preview raises Mermaid's default size limits (`maxTextSize`, `maxEdges`) so large generated diagrams render.

**AI**
- Provider-agnostic `AIProvider` interface with implementations for OpenAI, Azure OpenAI, Anthropic, Google Gemini, Ollama, and a generic OpenAI-compatible endpoint (covers Mistral/Groq/Together/OpenRouter/LM Studio/self-hosted)
- Generate / Explain / Improve / Fix / Modify / Ask / Review Architecture AI commands, all diagram-aware
- Every AI-proposed change goes through a VS Code diff view — nothing is applied without explicit confirmation
- API keys stored exclusively in VS Code SecretStorage
- Context sent to providers is minimal (current diagram + local lint/complexity summaries) and disclosed

**Known gaps** (see README "What's not built yet"): PDF export limits listed above, deep structural support for remaining diagram types (quadrantChart, requirementDiagram, C4, etc.), real-time multiplayer sync for comments (current implementation is local-first, file-based), code→Mermaid for languages beyond TS/JS, Python, Rust, C/C++, Java, C# and Go (e.g. Kotlin, Swift, PHP, Ruby) and framework coverage beyond the patterns each analyzer documents.
