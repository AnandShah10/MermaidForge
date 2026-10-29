import { describe, it, expect } from 'vitest';
import { parseCpp, analyzeCppClasses, cppCallGraphAnalyzer, analyzeCppIncludes } from '../src/analyzers/cpp/cppAnalyzer';

const f = (path: string, text: string) => ({ path, text });

const HEADER = `
#pragma once
#include <vector>
#include "base.h"

namespace shapes {

// class Fake { };
class Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;
    virtual std::string name() const { return "shape"; }
};

class Circle : public Shape, private Loggable {
public:
    Circle(double r, int id = 0);
    ~Circle();
    double area() const override;
    static Circle unit();
    void grow(double by) { radius_ += by; log(); }
protected:
    int id_;
private:
    double radius_;
    std::vector<int> tags_, extra_;
    void log() const;
};

struct Point {
    int x, y;
    double dist(const Point& o) const;
};

enum class Color { Red, Green = 2, Blue };

class Fwd;

} // namespace shapes
`;

describe('parseCpp classes', () => {
  const file = parseCpp(HEADER);
  const byName = Object.fromEntries(file.classes.map((c) => [c.name, c]));
  it('finds classes, structs and enums inside namespaces; ignores forward decls and comments', () => {
    expect(Object.keys(byName).sort()).toEqual(['Circle', 'Color', 'Point', 'Shape']);
  });
  it('reads bases and strips access specifiers', () => {
    expect(byName.Circle.bases).toEqual(['Shape', 'Loggable']);
  });
  it('reads enumerators', () => {
    expect(byName.Color.enumerators).toEqual(['Red', 'Green', 'Blue']);
    expect(byName.Color.kind).toBe('enum');
  });
  it('class members default to private, struct to public', () => {
    expect(byName.Point.fields).toContain('+x int');
    expect(byName.Point.fields).toContain('+y int');
  });
  it('tracks access labels for fields', () => {
    expect(byName.Circle.fields).toContain('#id_ int');
    expect(byName.Circle.fields).toContain('-radius_ double');
  });
  it('handles multiple declarators and templated types', () => {
    expect(byName.Circle.fields).toContain('-tags_ std::vector~int~');
    expect(byName.Circle.fields).toContain('-extra_ std::vector~int~');
  });
  it('captures methods with access, params, return type', () => {
    const m = byName.Circle.methods;
    const area = m.find((x) => x.name === 'area')!;
    expect(area.access).toBe('public');
    expect(area.ret).toBe('double');
    const grow = m.find((x) => x.name === 'grow')!;
    expect(grow.params).toBe('by');
    expect(grow.body).toContain('radius_ += by');
    expect(m.find((x) => x.name === 'log')!.access).toBe('private');
  });
  it('detects constructors/destructors (no return type) and static methods', () => {
    const m = byName.Circle.methods;
    expect(m.find((x) => x.name === 'Circle')!.ret).toBe('');
    expect(m.find((x) => x.name === '~Circle')).toBeTruthy();
    expect(m.find((x) => x.name === 'unit')!.isStatic).toBe(true);
  });
  it('detects pure virtuals', () => {
    expect(byName.Shape.methods.find((x) => x.name === 'area')!.isPureVirtual).toBe(true);
    expect(byName.Shape.methods.find((x) => x.name === 'name')!.isPureVirtual).toBe(false);
  });
  it('does not throw on garbage', () => {
    expect(() => parseCpp('class { ( ;;; struct X { int ; } template<')).not.toThrow();
  });
});

describe('analyzeCppClasses', () => {
  const { classes, relationships } = analyzeCppClasses([f('shapes.h', HEADER)]);
  const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
  it('marks classes with pure virtuals and data-less abstract bases', () => {
    expect(byId.Shape.stereotype).toBe('abstract'); // has a concrete virtual too
  });
  it('treats an all-pure-virtual, field-less class as an interface', () => {
    const r = analyzeCppClasses([f('i.h', 'class IFoo { public: virtual ~IFoo() {} virtual void run() = 0; };')]);
    expect(r.classes[0].stereotype).toBe('interface');
  });
  it('emits abstract marker, static marker and member formatting', () => {
    expect(byId.Shape.members).toContain('+area() double*');
    expect(byId.Circle.members).toContain('+unit() Circle$');
    expect(byId.Circle.members).toContain('-log() void');
  });
  it('enum members are enumerators', () => {
    expect(byId.Color.stereotype).toBe('enumeration');
    expect(byId.Color.members).toEqual(['Red', 'Green', 'Blue']);
  });
  it('emits inheritance edges', () => {
    expect(relationships).toContainEqual({ from: 'Circle', to: 'Shape', type: 'inheritance' });
    expect(relationships).toContainEqual({ from: 'Circle', to: 'Loggable', type: 'inheritance' });
  });
});

describe('cpp call graph', () => {
  const impl = `
#include "shapes.h"
static int twice(int v) { return v * 2; }
void report(const Circle& c) { c.log(); twice(3); Circle::unit(); }
Circle::Circle(double r, int id) : radius_(r), id_(id) { init(); }
void Circle::init() { log(); }
void Circle::log() const { twice(1); }
int main() { report(Circle(1)); return 0; }
`;
  const header = 'class Circle { public: Circle(double r, int id); void init(); void log() const; static Circle unit(); };';
  const g = cppCallGraphAnalyzer.analyze([f('shapes.h', header), f('shapes.cpp', impl)]);
  const has = (a: string, b: string) => g.edges.some((e) => e.from === `shapes.cpp::${a}` && e.to === `shapes.cpp::${b}`);
  it('registers out-of-line Class::method definitions with their class', () => {
    expect(g.nodes.map((n) => n.label)).toContain('Circle.init');
    expect(g.nodes.map((n) => n.label)).toContain('Circle.log');
  });
  it('links free function calls', () => {
    expect(has('main', 'report')).toBe(true);
    expect(has('report', 'twice')).toBe(true);
    expect(has('Circle.log', 'twice')).toBe(true);
  });
  it('links bare sibling calls inside a method (implicit this)', () => {
    expect(has('Circle.Circle', 'Circle.init')).toBe(true);
    expect(has('Circle.init', 'Circle.log')).toBe(true);
  });
  it('does not treat control keywords or macros as calls', () => {
    const gg = cppCallGraphAnalyzer.analyze([f('a.cpp', 'void a(){} void b(){ if (x) { a(); } while(1){} }')]);
    expect(gg.edges).toHaveLength(1);
  });
});

describe('cpp include graph', () => {
  const files = [
    f('src/main.cpp', '#include "util.h"\n#include "core/engine.h"\n#include <vector>\n// #include "ghost.h"\n'),
    f('src/util.h', '#include "core/engine.h"\n'),
    f('src/core/engine.h', '#include "../util.h"\n'),
  ];
  const g = analyzeCppIncludes(files);
  const has = (a: string, b: string) => g.edges.some((e) => e.from === a && e.to === b);
  it('resolves relative quoted includes', () => {
    expect(has('src/main.cpp', 'src/util.h')).toBe(true);
    expect(has('src/main.cpp', 'src/core/engine.h')).toBe(true);
    expect(has('src/core/engine.h', 'src/util.h')).toBe(true);
  });
  it('ignores system includes and commented-out includes', () => {
    expect(g.edges).toHaveLength(4);
  });
  it('falls back to path-suffix matching for include-dir style paths', () => {
    const gg = analyzeCppIncludes([f('a.cpp', '#include "proj/x.h"'), f('include/proj/x.h', '')]);
    expect(gg.edges).toHaveLength(1);
  });
});

describe('cpp call graph: direct-initialised locals', () => {
  it('resolves c.area() for `Circle c(2);`', () => {
    const g = cppCallGraphAnalyzer.analyze([{ path: 'a.cpp', text: 'class Circle { public: double area() const; };\ndouble Circle::area() const { return 1; }\nint main() { Circle c(2); return (int)c.area(); }\n' }]);
    expect(g.edges.map((e: { from: string; to: string }) => `${e.from.split('::')[1]}->${e.to.split('::')[1]}`)).toContain('main->Circle.area');
  });
});
