import { describe, it, expect } from 'vitest';

import { csharpRouteAnalyzer as convRoutes } from '../src/analyzers/csharp/csharpAnalyzer';
describe('ASP.NET conventional routing', () => {
  const lab = (g: ReturnType<typeof convRoutes.analyze>) => g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.replace(/<br\/>/g, ' | ')).sort();
  it('MapControllerRoute pattern fills controller and action for attribute-less controllers', () => {
    const g = convRoutes.analyze([
      { path: 'Program.cs', text: 'var app = builder.Build(); app.MapControllerRoute(name: "default", pattern: "{controller=Home}/{action=Index}/{id?}");' },
      { path: 'HomeController.cs', text: 'public class HomeController : Controller { public IActionResult Index() { return View(); } public IActionResult About() { return View(); } [HttpPost] public IActionResult Save() { return View(); } private void helper() {} }' },
    ]);
    expect(lab(g)).toEqual(['ANY /Home/About/{id?} | HomeController.About', 'ANY /Home/Index/{id?} | HomeController.Index', 'POST /Home/Save/{id?} | HomeController.Save']);
  });
  it('attribute-routed controllers are not also given conventional routes', () => {
    const g = convRoutes.analyze([
      { path: 'Program.cs', text: 'app.MapDefaultControllerRoute();' },
      { path: 'A.cs', text: '[Route("api/a")] public class AController : ControllerBase { [HttpGet] public int Get() { return 1; } }' },
    ]);
    expect(lab(g)).toEqual(['GET /api/a | AController.Get']);
  });
  it('a fixed pattern with defaults routes only to that controller/action', () => {
    const g = convRoutes.analyze([
      { path: 'Startup.cs', text: 'app.UseEndpoints(e => { e.MapControllerRoute(name: "blog", pattern: "blog/{slug}", defaults: new { controller = "Blog", action = "Show" }); });' },
      { path: 'B.cs', text: 'public class BlogController : Controller { public IActionResult Show(string slug) { return View(); } public IActionResult Other() { return View(); } }' },
    ]);
    expect(lab(g)).toEqual(['ANY /blog/{slug} | BlogController.Show']);
  });
});

describe('minimal API app detection', () => {
  it('finds an app built in one chained expression', () => {
    const g = convRoutes.analyze([{ path: 'Program.cs', text: 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/health", () => "ok");\nforeach (var n in new[] { "x", "y" }) { app.MapGet("/" + n, () => n); }\napp.Run();' }]);
    expect(g.nodes.filter((n) => n.kind === 'route').map((n) => n.label.split('<br/>')[0]).sort()).toEqual(['GET /health', 'GET /x', 'GET /y']);
  });
});
