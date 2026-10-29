import { CodeGraph, SourceFileInput } from './analyzer';
import { classesToClassDiagram, codeGraphToFlowchart, ExtractedClass, ExtractedRelationship } from './mermaidGenerator';
import { typeScriptImportGraphAnalyzer } from './typescript/importGraphAnalyzer';
import { typeScriptCallGraphAnalyzer } from './typescript/callGraphAnalyzer';
import { analyzeClasses as analyzeTsClasses } from './typescript/classDiagramAnalyzer';
import { reactComponentTreeAnalyzer } from './typescript/reactComponentTreeAnalyzer';
import { expressRouteAnalyzer } from './typescript/expressRouteAnalyzer';
import { nodeFrameworkRouteAnalyzer } from './typescript/nodeFrameworkRoutes';
import { analyzePythonClasses, pythonCallGraphAnalyzer, pythonImportGraphAnalyzer } from './python/pythonAnalyzer';
import { analyzeRustClasses, rustCallGraphAnalyzer, rustImportGraphAnalyzer } from './rust/rustAnalyzer';
import { rustRouteAnalyzer } from './rust/rustRouteAnalyzer';
import { pythonRouteAnalyzer } from './python/pythonRouteAnalyzer';
import { analyzeJavaClasses, javaCallGraphAnalyzer, javaImportGraphAnalyzer, javaRouteAnalyzer } from './java/javaAnalyzer';
import { analyzeCSharpClasses, csharpCallGraphAnalyzer, csharpImportGraphAnalyzer, csharpRouteAnalyzer } from './csharp/csharpAnalyzer';
import { analyzeGoClasses, goCallGraphAnalyzer, goImportGraphAnalyzer } from './go/goAnalyzer';
import { goRouteAnalyzer } from './go/goRouteAnalyzer';
import { analyzeKotlinClasses, kotlinCallGraphAnalyzer, kotlinImportGraphAnalyzer } from './kotlin/kotlinAnalyzer';
import { kotlinRouteAnalyzer } from './kotlin/kotlinRouteAnalyzer';
import { analyzeSwiftClasses, swiftCallGraphAnalyzer, swiftImportGraphAnalyzer } from './swift/swiftAnalyzer';
import { swiftRouteAnalyzer } from './swift/swiftRouteAnalyzer';
import { analyzePhpClasses, phpCallGraphAnalyzer, phpImportGraphAnalyzer } from './php/phpAnalyzer';
import { phpRouteAnalyzer } from './php/phpRouteAnalyzer';
import { analyzeRubyClasses, rubyCallGraphAnalyzer, rubyImportGraphAnalyzer } from './ruby/rubyAnalyzer';
import { rubyRouteAnalyzer } from './ruby/rubyRouteAnalyzer';
import { analyzeCppClasses, cppCallGraphAnalyzer, cppIncludeGraphAnalyzer } from './cpp/cppAnalyzer';

export type AnalysisKind = 'imports' | 'classes' | 'calls' | 'react' | 'express' | 'routes';

type Run = (files: SourceFileInput[]) => { graph: CodeGraph } | { classes: ExtractedClass[]; relationships: ExtractedRelationship[] };

export interface AnalysisDef {
  kind: AnalysisKind;
  label: string;
  description: string;
  /** Shown when the analysis finds nothing. */
  emptyMessage: string;
  direction?: 'TD' | 'LR';
  run: Run;
}

export interface LanguageDef {
  id: string;
  label: string;
  extensions: string[];
  analyses: AnalysisDef[];
}

const graphRun = (analyze: (f: SourceFileInput[]) => CodeGraph): Run => (f) => ({ graph: analyze(f) });

/** Concatenates graphs whose node ids are already distinct. */
function mergeGraphs(...graphs: CodeGraph[]): CodeGraph {
  return { nodes: graphs.flatMap((g) => g.nodes), edges: graphs.flatMap((g) => g.edges) };
}

const CALL_NOTE = 'name-based, approximate';

export const LANGUAGES: LanguageDef[] = [
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
    analyses: [
      { kind: 'imports', label: 'Import Graph', description: 'How files depend on each other', emptyMessage: 'No internal import relationships were found.', run: graphRun((f) => typeScriptImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, interfaces, and inheritance', emptyMessage: 'No class or interface declarations were found.', run: (f) => analyzeTsClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions or methods were found.', run: graphRun((f) => typeScriptCallGraphAnalyzer.analyze(f)) },
      { kind: 'react', label: 'React Component Tree', description: 'Which components render which', emptyMessage: 'No React components were found (looking for function/class components that return JSX).', direction: 'TD', run: graphRun((f) => reactComponentTreeAnalyzer.analyze(f)) },
      {
        kind: 'express',
        label: 'Node Web Routes',
        description: 'Express / Fastify / Koa / NestJS apps, routers, mounts and routes',
        emptyMessage: 'No Express, Fastify, Koa or NestJS routes were found (looking for express() / Router() / fastify() / new Koa() / @Controller).',
        run: graphRun((f) => mergeGraphs(expressRouteAnalyzer.analyze(f), nodeFrameworkRouteAnalyzer.analyze(f))),
      },
    ],
  },
  {
    id: 'python',
    label: 'Python',
    extensions: ['py'],
    analyses: [
      { kind: 'imports', label: 'Import Graph', description: 'How modules import each other', emptyMessage: 'No internal imports were found.', run: graphRun((f) => pythonImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, attributes, methods, inheritance', emptyMessage: 'No classes were found.', run: (f) => analyzePythonClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions or methods were found.', run: graphRun((f) => pythonCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Web Routes', description: 'Flask / Quart / FastAPI / Django routes, blueprints and routers', emptyMessage: 'No Flask, FastAPI or Django routes were found (looking for Flask()/FastAPI()/Blueprint()/APIRouter()/urlpatterns).', run: graphRun((f) => pythonRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'rust',
    label: 'Rust',
    extensions: ['rs'],
    analyses: [
      { kind: 'imports', label: 'Module Graph', description: 'mod / use relationships between files', emptyMessage: 'No internal mod/use relationships were found.', run: graphRun((f) => rustImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Type Diagram', description: 'Structs, enums, traits and impls', emptyMessage: 'No structs, enums or traits were found.', run: (f) => analyzeRustClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions were found.', run: graphRun((f) => rustCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Web Routes', description: 'actix-web / axum / Rocket / poem / tide / warp routes, scopes and nested routers', emptyMessage: 'No actix-web, axum, Rocket, poem, tide or warp routes were found (looking for Router::new()/App::new()/rocket::build()/Route::new()/tide::new()/warp::serve() and #[get("/..")] handlers).', run: graphRun((f) => rustRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'cpp',
    label: 'C / C++',
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
    analyses: [
      { kind: 'imports', label: 'Include Graph', description: 'Which files #include which', emptyMessage: 'No project-local #include relationships were found.', run: graphRun((f) => cppIncludeGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, structs, enums and inheritance', emptyMessage: 'No classes or structs were found.', run: (f) => analyzeCppClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions were found.', run: graphRun((f) => cppCallGraphAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'java',
    label: 'Java',
    extensions: ['java'],
    analyses: [
      { kind: 'imports', label: 'Import Graph', description: 'Which classes/files import which', emptyMessage: 'No project-internal imports were found.', run: graphRun((f) => javaImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, interfaces, enums, records and inheritance', emptyMessage: 'No classes or interfaces were found.', run: (f) => analyzeJavaClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Method calls (${CALL_NOTE})`, emptyMessage: 'No methods were found.', run: graphRun((f) => javaCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Web Routes', description: 'Spring MVC / JAX-RS controllers and endpoints', emptyMessage: 'No Spring or JAX-RS controllers were found (looking for @RestController / @Controller / @Path).', run: graphRun((f) => javaRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'csharp',
    label: 'C#',
    extensions: ['cs'],
    analyses: [
      { kind: 'imports', label: 'Using Graph', description: 'Which files depend on which namespaces', emptyMessage: 'No project-internal using relationships were found.', run: graphRun((f) => csharpImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, interfaces, structs, records and inheritance', emptyMessage: 'No types were found.', run: (f) => analyzeCSharpClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Method calls (${CALL_NOTE})`, emptyMessage: 'No methods were found.', run: graphRun((f) => csharpCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'ASP.NET Routes', description: 'Controllers and minimal-API endpoints', emptyMessage: 'No ASP.NET controllers or minimal-API routes were found.', run: graphRun((f) => csharpRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'go',
    label: 'Go',
    extensions: ['go'],
    analyses: [
      { kind: 'imports', label: 'Package Graph', description: 'Which packages (directories) import which', emptyMessage: 'No project-internal package imports were found.', run: graphRun((f) => goImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Type Diagram', description: 'Structs, interfaces, embedding and inferred implements', emptyMessage: 'No struct or interface types were found.', run: (f) => analyzeGoClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions were found.', run: graphRun((f) => goCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Web Routes', description: 'net/http, gin, echo, fiber, chi, gorilla/mux routes', emptyMessage: 'No Go web routes were found (looking for http.HandleFunc, gin/echo/fiber/chi/mux routers).', run: graphRun((f) => goRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    extensions: ['kt', 'kts'],
    analyses: [
      { kind: 'imports', label: 'Import Graph', description: 'Which files import which', emptyMessage: 'No project-internal imports were found.', run: graphRun((f) => kotlinImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, interfaces, objects, data/sealed/enum classes and inheritance', emptyMessage: 'No classes or interfaces were found.', run: (f) => analyzeKotlinClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions were found.', run: graphRun((f) => kotlinCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Web Routes', description: 'Spring controllers and Ktor routing', emptyMessage: 'No Spring controllers or Ktor routes were found (looking for @RestController / @RequestMapping and routing { }).', run: graphRun((f) => kotlinRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'swift',
    label: 'Swift',
    extensions: ['swift'],
    analyses: [
      { kind: 'imports', label: 'Module Graph', description: 'Which modules (SwiftPM targets) import which', emptyMessage: 'No project-internal module imports were found.', run: graphRun((f) => swiftImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Type Diagram', description: 'Classes, structs, enums, protocols, actors and extensions', emptyMessage: 'No types were found.', run: (f) => analyzeSwiftClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions were found.', run: graphRun((f) => swiftCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Vapor Routes', description: 'Vapor routes, groups and route collections', emptyMessage: 'No Vapor routes were found (looking for app.get/post/…, grouped(), group() and RouteCollection).', run: graphRun((f) => swiftRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'php',
    label: 'PHP',
    extensions: ['php'],
    analyses: [
      { kind: 'imports', label: 'Import Graph', description: 'Which files use/require which', emptyMessage: 'No project-internal use/require relationships were found.', run: graphRun((f) => phpImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, interfaces, traits, enums and inheritance', emptyMessage: 'No classes or interfaces were found.', run: (f) => analyzePhpClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Function/method calls (${CALL_NOTE})`, emptyMessage: 'No functions or methods were found.', run: graphRun((f) => phpCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Web Routes', description: 'Laravel routes and Symfony #[Route] attributes', emptyMessage: 'No Laravel routes or #[Route] attributes were found.', run: graphRun((f) => phpRouteAnalyzer.analyze(f)) },
    ],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    extensions: ['rb'],
    analyses: [
      { kind: 'imports', label: 'Require Graph', description: 'Which files require/autoload which', emptyMessage: 'No project-internal requires were found.', run: graphRun((f) => rubyImportGraphAnalyzer.analyze(f)) },
      { kind: 'classes', label: 'Class Diagram', description: 'Classes, modules, mixins and inheritance', emptyMessage: 'No classes or modules were found.', run: (f) => analyzeRubyClasses(f) },
      { kind: 'calls', label: 'Call Graph', description: `Method calls (${CALL_NOTE})`, emptyMessage: 'No methods were found.', run: graphRun((f) => rubyCallGraphAnalyzer.analyze(f)) },
      { kind: 'routes', label: 'Web Routes', description: 'Rails routes.rb and Sinatra routes', emptyMessage: 'No Rails or Sinatra routes were found (looking for routes.rb DSL and Sinatra get/post blocks).', run: graphRun((f) => rubyRouteAnalyzer.analyze(f)) },
    ],
  },
];

export function globForLanguage(lang: LanguageDef): string {
  return `**/*.{${lang.extensions.join(',')}}`;
}

/** Above this many edges a generated flowchart is rarely readable; the user is told to narrow the scan. */
export const LARGE_GRAPH_EDGES = 400;

export interface AnalysisOutcome {
  /** Mermaid source, or null when the analysis found nothing worth drawing. */
  mermaid: string | null;
  /** Human-readable note (empty-result explanation, or a caveat). */
  note?: string;
}

/** Runs one analysis and renders it to Mermaid. Pure — no VS Code dependency. */
export function runAnalysis(languageId: string, kind: AnalysisKind, files: SourceFileInput[]): AnalysisOutcome {
  const lang = LANGUAGES.find((l) => l.id === languageId);
  const def = lang?.analyses.find((a) => a.kind === kind);
  if (!lang || !def) return { mermaid: null, note: `"${kind}" analysis is not available for ${languageId}.` };

  const result = def.run(files);
  if ('graph' in result) {
    if (result.graph.nodes.length === 0) return { mermaid: null, note: def.emptyMessage };
    const edges = result.graph.edges.length;
    const ambiguous = result.graph.edges.filter((e) => e.kind === 'ambiguous').length;
    const notes: string[] = [];
    if (edges === 0) notes.push('Nodes were found but no relationships between them could be resolved (these analyzers are syntax/name-based).');
    else if (edges > LARGE_GRAPH_EDGES) notes.push(`This graph has ${edges} edges and may be slow to render and hard to read — consider scanning a smaller folder.`);
    if (ambiguous > 0) notes.push(`${ambiguous} dotted edge${ambiguous === 1 ? '' : 's'}: the called name matches several functions and nothing in the file's imports says which one is meant, so every match is drawn.`);
    return { mermaid: codeGraphToFlowchart(result.graph, def.direction ?? 'LR'), note: notes.length ? notes.join(' ') : undefined };
  }
  if (result.classes.length === 0) return { mermaid: null, note: def.emptyMessage };
  return { mermaid: classesToClassDiagram(result.classes, result.relationships) };
}
