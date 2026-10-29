import { describe, it, expect } from 'vitest';
import { scrub, matchBrace, splitTopLevel, sanitizeType } from '../src/analyzers/common/scrubber';

describe('scrub (python)', () => {
  it('blanks comments and strings but keeps length and newlines', () => {
    const src = 'x = "a(b)"  # def fake():\ny = 1';
    const out = scrub(src, 'python');
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('fake');
    expect(out).not.toContain('a(b)');
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('y = 1');
  });
  it('blanks triple-quoted docstrings across lines', () => {
    const out = scrub('def f():\n    """class Fake:\n    pass"""\n    return 1', 'python');
    expect(out).not.toContain('Fake');
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toContain('return 1');
  });
  it('handles prefixed and raw strings', () => {
    expect(scrub("a = r'\\d+ # not comment'\nb = f\"{x}\"", 'python')).not.toContain('not comment');
  });
  it('does not treat an identifier ending in a quote prefix letter as a string', () => {
    expect(scrub('bar = 1', 'python')).toBe('bar = 1');
  });
});

describe('scrub (rust)', () => {
  it('blanks line, nested block comments and strings', () => {
    const out = scrub('fn a() {} // fn fake() {}\n/* outer /* inner */ still */ fn b() {}\nlet s = "fn nope() {}";', 'rust');
    expect(out).not.toContain('fake');
    expect(out).not.toContain('inner');
    expect(out).not.toContain('still');
    expect(out).not.toContain('nope');
    expect(out).toContain('fn b()');
  });
  it('keeps lifetimes but blanks char literals', () => {
    const out = scrub("fn f<'a>(x: &'a str) { let c = '{'; }", 'rust');
    expect(out).toContain("'a");
    expect(out).not.toContain("'{'");
    expect(out.match(/\{/g)!.length).toBe(1); // only the fn body brace remains
  });
  it('blanks raw strings', () => {
    expect(scrub('let s = r#"fn x() { "quoted" }"#;', 'rust')).not.toContain('quoted');
  });
});

describe('scrub (cpp)', () => {
  it('blanks comments, strings, chars and raw strings', () => {
    const out = scrub('int a; // class X {};\nconst char* s = "}";\nchar c = \'{\';\nauto r = R"(class Y {)";', 'cpp');
    expect(out).not.toContain('class X');
    expect(out).not.toContain('class Y');
    expect(out).not.toContain('"}"');
    expect(out.match(/[{}]/g)).toBeNull();
  });
  it('does not treat digit separators as char literals', () => {
    expect(scrub("int n = 1'000'000; int k;", 'cpp')).toContain('int k;');
  });
});

describe('helpers', () => {
  it('matchBrace finds the matching brace', () => {
    const t = '{ a { b } c } d';
    expect(matchBrace(t, 0)).toBe(12);
  });
  it('matchBrace returns length when unbalanced', () => {
    expect(matchBrace('{ a', 0)).toBe(3);
  });
  it('splitTopLevel respects nesting', () => {
    expect(splitTopLevel('a, Map<K, V>, f(x, y), [1, 2]', ',')).toEqual(['a', 'Map<K, V>', 'f(x, y)', '[1, 2]']);
  });
  it('splitTopLevel treats -> as not closing an angle bracket', () => {
    expect(splitTopLevel('Fn(i32) -> i32, T', ',')).toEqual(['Fn(i32) -> i32', 'T']);
  });
  it('sanitizeType converts generics, drops lifetimes, rewrites parens', () => {
    expect(sanitizeType("&'a Vec<String>")).toBe('&Vec~String~');
    expect(sanitizeType('(i32, i32)')).toBe('[i32, i32]');
    expect(sanitizeType('HashMap<K, Vec<V>>')).toBe('HashMap~K, Vec~V~~');
  });
});
