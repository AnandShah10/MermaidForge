import { describe, it, expect } from 'vitest';
import { parseXml, findFirstElement, decodeEntities } from '../src/rendering/svg/miniXmlParser';

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#65;&#x42;')).toBe('a & b <c> "d" AB');
  });
  it('leaves unknown entities untouched', () => {
    expect(decodeEntities('&bogus;')).toBe('&bogus;');
  });
});

describe('parseXml', () => {
  it('parses nested elements and attributes', () => {
    const [root] = parseXml('<svg width="10" height=\'20\'><g id="a"><rect x="1"/></g></svg>');
    expect(root.name).toBe('svg');
    expect(root.attrs).toEqual({ width: '10', height: '20' });
    expect(root.children[0].children[0].name).toBe('rect');
    expect(root.children[0].children[0].attrs.x).toBe('1');
  });
  it('strips declaration, comments and doctype', () => {
    const nodes = parseXml('<?xml version="1.0"?><!DOCTYPE svg><!-- hi --><svg/>');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('svg');
  });
  it('captures text and decodes entities', () => {
    const [t] = parseXml('<text>a &amp; b</text>');
    expect(t.text).toBe('a & b');
  });
  it('preserves text/child ordering in parts', () => {
    const [s] = parseXml('<span>a<br/>b</span>');
    expect(s.parts.map((p) => (typeof p === 'string' ? p : p.name))).toEqual(['a', 'br', 'b']);
  });
  it('keeps > inside quoted attribute values', () => {
    const [n] = parseXml('<a title="x>y" b="1"/>');
    expect(n.attrs.title).toBe('x>y');
    expect(n.attrs.b).toBe('1');
  });
  it('treats CDATA as text', () => {
    const [n] = parseXml('<style><![CDATA[a > b { }]]></style>');
    expect(n.text).toBe('a > b { }');
  });
  it('recovers from mismatched close tags', () => {
    const nodes = parseXml('<svg><g><rect/></svg><p/>');
    expect(nodes.map((n) => n.name)).toEqual(['svg', 'p']);
  });
  it('ignores stray closers', () => {
    expect(parseXml('</x><svg/>').map((n) => n.name)).toEqual(['svg']);
  });
  it('handles namespaced attributes', () => {
    const [n] = parseXml('<svg xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/>');
    expect(n.attrs['xlink:href']).toBe('#a');
  });
  it('findFirstElement searches depth-first', () => {
    const nodes = parseXml('<div><p><svg id="x"/></p></div>');
    expect(findFirstElement(nodes, 'svg')?.attrs.id).toBe('x');
    expect(findFirstElement(nodes, 'nope')).toBeNull();
  });
  it('returns empty for empty input', () => {
    expect(parseXml('')).toEqual([]);
  });
});
