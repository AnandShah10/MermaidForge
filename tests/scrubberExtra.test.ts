import { describe, it, expect } from 'vitest';
import { scrub } from '../src/analyzers/common/scrubber';

const same = (a: string, b: string) => {
  expect(b.length).toBe(a.length);
  expect(b.split('\n').length).toBe(a.split('\n').length);
};

describe('scrub: kotlin', () => {
  it('blanks comments (nested), strings, raw strings and chars', () => {
    const src = `fun a() { /* x /* y */ z */ val s = "get(\\"/x\\")" // c\n val r = """\nfoo()\n"""; val c = 'x' }`;
    const o = scrub(src, 'kotlin');
    same(src, o);
    expect(o).not.toMatch(/foo|get|\bz\b/);
    expect(o).toContain('val s');
  });
});
describe('scrub: swift', () => {
  it('blanks // and nested /* */, strings, multi-line and raw strings', () => {
    const src = `func a() { /* x /* y */ z */ let s = "a\\(b)" // c\n let r = #"raw "q" foo()"#\n let m = """\nbar()\n""" }`;
    const o = scrub(src, 'swift');
    same(src, o);
    expect(o).not.toMatch(/foo|bar|\bz\b/);
    expect(o).toContain('let s');
  });
});
describe('scrub: php', () => {
  it('blanks inline html, comments, strings and heredocs but keeps #[attributes]', () => {
    const src = `<html>hidden()</html>\n<?php\n// c\n# d\n/* e */\n#[Route('/x')]\n$s = "q()"; $t = 'r()';\n$h = <<<EOT\nbody()\nEOT;\n?>\nafter()`;
    const o = scrub(src, 'php');
    same(src, o);
    expect(o).not.toMatch(/hidden|body|after|q\(\)|r\(\)/);
    expect(o).toContain('#[Route(');
    expect(o).toContain('$s =');
  });
});
describe('scrub: ruby', () => {
  it('blanks comments, =begin blocks, strings, %w literals and heredoc bodies', () => {
    const src = `# c\nx = "a()" # d\n=begin\nhidden()\n=end\nw = %w[a b()]\ny = <<~EOS\n  body()\nEOS\nz = 1\nlist << CONST\n`;
    const o = scrub(src, 'ruby');
    same(src, o);
    expect(o).not.toMatch(/hidden|body|a\(\)|b\(\)/);
    expect(o).toContain('z = 1');
    expect(o).toContain('list << CONST');
  });
});
