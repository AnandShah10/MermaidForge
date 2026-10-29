import * as ts from 'typescript';
import * as posixPath from 'path/posix';

/**
 * Evaluation of the small, static part of loops that register routes:
 *
 *   ['users', 'posts'].forEach((name) => app.use('/' + name, require('./routes/' + name)));
 *   for (const r of [{ path: '/a', router: a }, ...]) app.use(r.path, r.router);
 *   fs.readdirSync(path.join(__dirname, 'routes')).forEach((f) => app.use('/' + f.replace('.js', ''), require('./routes/' + f)));
 *
 * Nothing is executed. Only expressions made of string literals, templates, `+`, the loop variable, its object
 * properties, `path.join/resolve/basename/parse(..).name` and a few string methods are evaluated; anything else
 * makes the whole expression unknown (null) and the loop body is then left to the ordinary analysis.
 */

/** What a loop variable is bound to for one iteration: a plain string, or the element's source expression. */
export type Binding = string | ts.Expression;
export type Env = Map<string, Binding>;

/** `__dirname` is the folder of the file being read; it evaluates to this marker, which `path.join` keeps. */
export const DIR_MARK = './';

const asRegExp = (e: ts.Expression): RegExp | null => {
  if (!ts.isRegularExpressionLiteral(e)) return null;
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(e.text);
  try {
    return m ? new RegExp(m[1], m[2]) : null;
  } catch {
    return null;
  }
};

/** Evaluates `e` to a string under `env`, or null when any part of it is not statically known. */
export function evalString(e: ts.Expression | undefined, env: Env, depth = 0): string | null {
  if (!e || depth > 12) return null;
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) return evalString(e.expression, env, depth + 1);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    for (const span of e.templateSpans) {
      const v = evalString(span.expression, env, depth + 1);
      if (v === null) return null;
      out += v + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = evalString(e.left, env, depth + 1);
    const b = evalString(e.right, env, depth + 1);
    return a !== null && b !== null ? a + b : null;
  }
  if (ts.isIdentifier(e)) {
    if (e.text === '__dirname') return DIR_MARK;
    const b = env.get(e.text);
    if (b === undefined) return null;
    return typeof b === 'string' ? b : evalString(b, env, depth + 1);
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    const b = env.get(e.expression.text);
    if (b !== undefined && typeof b !== 'string' && ts.isObjectLiteralExpression(b)) return evalString(propertyOf(b, e.name.text), env, depth + 1);
    return null;
  }
  if (ts.isElementAccessExpression(e) && ts.isCallExpression(e.expression) && ts.isPropertyAccessExpression(e.expression.expression) && e.expression.expression.name.text === 'split') {
    // `file.split('.')[0]`
    const base = evalString(e.expression.expression.expression, env, depth + 1);
    const sep = evalString(e.expression.arguments[0], env, depth + 1);
    const idx = ts.isNumericLiteral(e.argumentExpression) ? Number(e.argumentExpression.text) : NaN;
    return base !== null && sep !== null && Number.isInteger(idx) ? base.split(sep)[idx] ?? null : null;
  }
  if (ts.isPropertyAccessExpression(e) && ts.isCallExpression(e.expression) && e.name.text === 'name') {
    // `path.parse(file).name`
    const c = e.expression;
    if (ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'parse') {
      const v = evalString(c.arguments[0], env, depth + 1);
      return v === null ? null : posixPath.parse(v).name;
    }
    return null;
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const name = e.expression.name.text;
    const recv = e.expression.expression;
    // path.join / path.resolve / path.basename
    if (ts.isIdentifier(recv) && recv.text === 'path') {
      const args = e.arguments.map((a) => evalString(a, env, depth + 1));
      if (args.some((a) => a === null)) return null;
      const parts = args as string[];
      if (name === 'join' || name === 'resolve') {
        const joined = posixPath.join(...parts);
        return parts[0] === DIR_MARK && !joined.startsWith('.') ? DIR_MARK + joined : joined;
      }
      if (name === 'basename') return posixPath.basename(parts[0], parts[1]);
      return null;
    }
    const base = evalString(recv, env, depth + 1);
    if (base === null) return null;
    if (name === 'replace' || name === 'replaceAll') {
      const re = asRegExp(e.arguments[0]);
      const to = evalString(e.arguments[1], env, depth + 1);
      if (to === null) return null;
      if (re) return base.replace(re, to);
      const from = evalString(e.arguments[0], env, depth + 1);
      return from === null ? null : name === 'replaceAll' ? base.split(from).join(to) : base.replace(from, () => to);
    }
    if (name === 'toLowerCase') return base.toLowerCase();
    if (name === 'toUpperCase') return base.toUpperCase();
    if (name === 'slice' || name === 'substring') {
      const a = ts.isNumericLiteral(e.arguments[0] ?? e) ? Number((e.arguments[0] as ts.NumericLiteral).text) : ts.isPrefixUnaryExpression(e.arguments[0] ?? e) ? -Number(((e.arguments[0] as ts.PrefixUnaryExpression).operand as ts.NumericLiteral).text) : NaN;
      const b0 = e.arguments[1];
      const b = !b0 ? undefined : ts.isNumericLiteral(b0) ? Number(b0.text) : ts.isPrefixUnaryExpression(b0) ? -Number((b0.operand as ts.NumericLiteral).text) : NaN;
      if (Number.isNaN(a) || (b !== undefined && Number.isNaN(b))) return null;
      return name === 'slice' ? base.slice(a, b) : base.substring(a, b);
    }
    return null;
  }
  return null;
}

/** The initializer of `key` in an object literal (also for shorthand properties). */
export function propertyOf(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) return p.name;
  }
  return undefined;
}

/** Elements of an array literal, or of the top-level `const NAME = [..]` it names in the same file. */
export function literalElements(sf: ts.SourceFile, e: ts.Expression): ts.Expression[] | null {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e)) return [...e.elements];
  if (ts.isIdentifier(e)) {
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === e.text && d.initializer) {
          let init = d.initializer;
          while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init)) init = init.expression;
          return ts.isArrayLiteralExpression(init) ? [...init.elements] : null;
        }
      }
    }
  }
  return null;
}

/** `fs.readdirSync(dir)` possibly followed by `.filter(..)`/`.sort()`: the directory expression, else null. */
export function readdirTarget(e: ts.Expression): ts.Expression | null {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const name = e.expression.name.text;
    if (name === 'readdirSync') return e.arguments[0] ?? null;
    if (name === 'filter' || name === 'sort' || name === 'map') return readdirTarget(e.expression.expression);
  }
  return null;
}

export interface Loop {
  /** Loop variable names bound per iteration (the item, and for forEach also the index which stays unbound). */
  param: string;
  iterable: ts.Expression;
  body: ts.Node;
}

/** `xs.forEach((p) => ..)` and `for (const p of xs) ..`. */
export function asLoop(n: ts.Node): Loop | null {
  if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
    const d = n.initializer.declarations[0];
    if (d && ts.isIdentifier(d.name)) return { param: d.name.text, iterable: n.expression, body: n.statement };
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'forEach') {
    const cb = n.arguments[0];
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name)) {
      return { param: cb.parameters[0].name.text, iterable: n.expression.expression, body: cb.body };
    }
  }
  return null;
}

/** File names (with extension) directly inside `dir` among the scanned files, ignoring index files, tests and typings. */
export function filesInDir(known: Iterable<string>, dir: string): string[] {
  const out: string[] = [];
  const norm = posixPath.normalize(dir).replace(/\/$/, '');
  for (const f of known) {
    if (posixPath.dirname(f) !== norm) continue;
    const base = posixPath.basename(f);
    if (/^index\./.test(base) || /\.d\.ts$/.test(base) || /\.(test|spec)\./.test(base)) continue;
    if (!/\.(?:[cm]?[jt]sx?)$/.test(base)) continue;
    out.push(base);
  }
  return out.sort();
}
