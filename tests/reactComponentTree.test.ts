import { describe, it, expect } from 'vitest';
import { reactComponentTreeAnalyzer } from '../src/analyzers/typescript/reactComponentTreeAnalyzer';

const f = (path: string, text: string) => ({ path, text });
const labels = (g: ReturnType<typeof reactComponentTreeAnalyzer.analyze>) => g.nodes.map((n) => n.label).sort();
const edgePairs = (g: ReturnType<typeof reactComponentTreeAnalyzer.analyze>) =>
  g.edges.map((e) => `${g.nodes.find((n) => n.id === e.from)!.label}->${g.nodes.find((n) => n.id === e.to)!.label}`).sort();

describe('react component tree', () => {
  const files = [
    f('src/App.tsx', `
import React from 'react';
import Header from './components/Header';
import { Sidebar as Nav, Footer } from './components/parts';
import Button from '@mui/material/Button';
import { useState } from 'react';
export default function App() {
  const [n] = useState(0);
  return <div><Header title="x" /><Nav><Footer /></Nav><Button>ok</Button><Ctx.Provider value={1}><Card/></Ctx.Provider></div>;
}
function Card() { return <section>card</section>; }
`),
    f('src/components/Header.tsx', `
import Logo from './Logo';
const Header = ({ title }: { title: string }) => <header><Logo />{title}</header>;
export default React.memo(Header);
`),
    f('src/components/Logo.jsx', `export default function Logo() { return <img/>; }`),
    f('src/components/parts.tsx', `
export const Sidebar = ({ children }) => <aside>{children}</aside>;
export const Footer = () => <footer/>;
export function helper() { return 1; }
const lower = () => <div/>;
`),
  ];
  const g = reactComponentTreeAnalyzer.analyze(files);

  it('detects function, arrow, memo-wrapped and default-exported components', () => {
    expect(labels(g)).toEqual(['App', 'Card', 'Footer', 'Header', 'Logo', 'Sidebar']);
  });
  it('does not treat non-JSX functions or lowercase names as components', () => {
    expect(labels(g)).not.toContain('helper');
    expect(labels(g)).not.toContain('lower');
  });
  it('links parents to children across files, through default and aliased named imports', () => {
    const e = edgePairs(g);
    expect(e).toContain('App->Header');
    expect(e).toContain('App->Sidebar'); // <Nav> is an alias of Sidebar
    expect(e).toContain('App->Footer');
    expect(e).toContain('Header->Logo');
  });
  it('links same-file components', () => expect(edgePairs(g)).toContain('App->Card'));
  it('skips third-party and member-expression tags', () => {
    const e = edgePairs(g);
    expect(e.some((x) => x.includes('Button') || x.includes('Provider'))).toBe(false);
  });
  it('has no duplicate edges', () => expect(new Set(edgePairs(g)).size).toBe(g.edges.length));

  it('detects class components', () => {
    const gg = reactComponentTreeAnalyzer.analyze([
      f('a.jsx', `class Page extends React.Component { render() { return <Row/>; } }\nclass Row extends PureComponent { render() { return <i/>; } }\nclass Plain { render() {} }`),
    ]);
    expect(labels(gg)).toEqual(['Page', 'Row']);
    expect(edgePairs(gg)).toEqual(['Page->Row']);
  });
  it('detects forwardRef/memo wrapped consts', () => {
    const gg = reactComponentTreeAnalyzer.analyze([f('a.tsx', `const Input = React.forwardRef((p, ref) => <input ref={ref}/>);\nconst Form = memo(() => <form><Input/></form>);`)]);
    expect(labels(gg)).toEqual(['Form', 'Input']);
    expect(edgePairs(gg)).toEqual(['Form->Input']);
  });
  it('detects createElement-based components', () => {
    const gg = reactComponentTreeAnalyzer.analyze([f('a.js', `function Box() { return React.createElement('div'); }`)]);
    expect(labels(gg)).toEqual(['Box']);
  });
  it('does not guess when a child name is ambiguous across files', () => {
    const gg = reactComponentTreeAnalyzer.analyze([
      f('a.tsx', `export const Item = () => <i/>;`),
      f('b.tsx', `export const Item = () => <b/>;`),
      f('c.tsx', `export const List = () => <ul><Item/></ul>;`),
    ]);
    expect(gg.edges).toHaveLength(0);
    expect(gg.nodes.filter((n) => n.label.startsWith('Item (')).length).toBe(2); // disambiguated labels
  });
  it('names anonymous default exports after the file', () => {
    const gg = reactComponentTreeAnalyzer.analyze([f('src/my-page.tsx', `export default () => <div/>;`)]);
    expect(labels(gg)).toEqual(['MyPage']);
  });
  it('ignores self-references and tolerates syntax errors', () => {
    const gg = reactComponentTreeAnalyzer.analyze([f('a.tsx', `const A = () => <A/>;\nconst B = () => <div`)]);
    expect(gg.edges).toHaveLength(0);
  });
});
