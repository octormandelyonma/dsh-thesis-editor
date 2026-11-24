const textEscapes = { '\\': '\\textbackslash{}', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
const escapeText = value => value.replace(/\s+/g, ' ').trim().replace(/[\\{}$&#_%^~]/g, char => textEscapes[char] || '\\' + char);
export const IMAGE_PATH = /\.(pdf|png|jpe?g)$/i;
export const validImage = path => IMAGE_PATH.test(path) && !/[{}%#\\^~"\x00-\x1f]/.test(path);
export const validLabel = label => !label || /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(label);
export const ROW_LIMIT = 40;
export const COLUMN_LIMIT = 12;

function captionLines(caption, label) {
  return [
    ...(caption.trim() ? ['  \\caption{' + escapeText(caption) + '}'] : []),
    ...(label && caption.trim() ? ['  \\label{' + label + '}'] : [])
  ];
}

export function figureSource({ image, caption, label, width, placement }) {
  const fraction = String(Number(width) / 100);
  return [
    '', '\\begin{figure}[' + placement + ']', '  \\centering',
    '  \\includegraphics[width=' + fraction + '\\linewidth]{\\detokenize{' + image + '}}',
    ...captionLines(caption, label), '\\end{figure}', ''
  ].join('\n');
}

export function tableSource({ cells, align, caption, label, booktabs = false }) {
  const row = values => '    ' + values.map(escapeText).join(' & ') + ' \\\\';
  const rules = booktabs ? ['\\toprule', '\\midrule', '\\bottomrule']
    : ['\\noalign{\\hrule height 0.8pt\\vskip 3pt}', '\\noalign{\\vskip 3pt\\hrule height 0.45pt\\vskip 3pt}', '\\noalign{\\vskip 3pt\\hrule height 0.8pt}'];
  return [
    '', '\\begin{table}[htbp]', '  \\centering', ...captionLines(caption, label),
    '  \\begin{tabular}{' + align.join('') + '}',
    '    ' + rules[0], row(cells[0]), '    ' + rules[1],
    ...cells.slice(1).map(row), '    ' + rules[2],
    '  \\end{tabular}', '\\end{table}', ''
  ].join('\n');
}

export function rectangularTable(rows) {
  if (rows.length < 2 || rows.length > ROW_LIMIT) return null;
  const columns = Math.max(...rows.map(row => row.length));
  if (!columns || columns > COLUMN_LIMIT || rows.some(row => row.some(cell => cell.length > 500))) return null;
  return rows.map(row => Array.from({ length: columns }, (_, column) => row[column] || ''));
}

export function parsePastedTable(text) {
  if (text.length > ROW_LIMIT * COLUMN_LIMIT * 501) return null;
  return rectangularTable(text.replace(/(?:\r?\n)+$/, '').split(/\r?\n/).map(line => line.split('\t')));
}

const verbatim = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment']);
const mathEnv = /^(?:math|displaymath|equation|align|alignat|flalign|gather|multline|eqnarray|split|aligned|array|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|cases)\*?$/;
const floatEnv = /^(?:figure|table|tabular|tabularx|longtable|minipage|abstract|multicols)\*?$/;
const inlineGroup = /^\\(?:textbf|textit|underline|texttt|emph)\s*\{$/;
const tokens = /%[^\r\n]*|\\verb(?![A-Za-z@])\*?([^\s])[^\r\n]*?\1|\\(begin|end)\s*\{([^{}\r\n]+)\}|\\[A-Za-z@]+[ \t]*\{|\\[^\r\n]|\$\$?|[{}]/g;

export function scanSource(source, floats) {
  const spans = [];
  const groups = [];
  const environments = [];
  const abstractEnds = [];
  let start = null, end = null, begin = null, math = null, literal = null;
  const protect = (from, to, reason) => spans.push({ from, to, reason });
  for (const match of source.matchAll(tokens)) {
    const [token, verb, direction, name] = match, at = match.index, after = at + token.length;
    if (literal) {
      if (direction === 'end' && name === literal.name) {
        protect(literal.at, after, 'insertLiteral');
        literal = null;
      }
      continue;
    }
    if (token[0] === '%') {
      protect(at, after + 1, 'insertComment');
    } else if (verb) {
      protect(at, after, 'insertLiteral');
    } else if (direction && name === 'document' && !groups.length && !math) {
      if (direction === 'begin' && start === null) { start = after; begin = at; }
      if (direction === 'end' && end === null) end = at;
    } else if (direction) {
      protect(at, after, 'insertGroup');
      if (direction === 'begin' && verbatim.has(name)) literal = { name, at };
      else if (direction === 'begin' && (mathEnv.test(name) || (floats && floatEnv.test(name)))) {
        environments.push({ name, at, reason: mathEnv.test(name) ? 'insertMath' : 'insertFloat' });
      } else if (direction === 'end' && environments.at(-1)?.name === name) {
        const environment = environments.pop();
        protect(environment.at, after, environment.reason);
        if (name === 'abstract' || name === 'abstract*') abstractEnds.push(after);
      }
    } else if (token === '$' || token === '$$' || token === '\\(' || token === '\\[' || token === '\\)' || token === '\\]') {
      if (math?.close === token) { protect(math.at, after, 'insertMath'); math = null; }
      else if (!math && token !== '\\)' && token !== '\\]') {
        math = { at, close: token === '\\(' ? '\\)' : token === '\\[' ? '\\]' : token };
      }
    } else if (token.endsWith('{') && token !== '\\{') {
      if (token.length > 1) protect(at, after, 'insertGroup');
      groups.push({ at: after - 1, inline: inlineGroup.test(token) });
    } else if (token === '}' && groups.length) {
      const group = groups.pop();
      protect(group.at, after, group.inline ? 'inline' : 'insertGroup');
    }
  }
  for (const group of groups) protect(group.at, source.length + 1, 'insertGroup');
  for (const environment of environments) protect(environment.at, source.length + 1, environment.reason);
  if (math) protect(math.at, source.length + 1, 'insertMath');
  if (literal) protect(literal.at, source.length + 1, 'insertLiteral');
  return { start, end, begin, spans, abstractEnds };
}

// Inspect the active document body. Standalone chapter files have no document wrapper.
function contentsInfo(source, main = false) {
  const { start, end, begin, spans, abstractEnds } = scanSource(source, true);
  if (main && start == null) return null;
  const lower = start ?? 0, upper = end ?? source.length;
  const commands = [];
  const includes = [];
  const features = new Set();
  let existing = null, firstSection = upper;
  const active = at => at >= lower && at < upper && !spans.some(span => span.from < at && at < span.to);
  for (const match of source.matchAll(/\\(?:[A-Za-z@]+|[^\r\n])/g)) {
    const command = match[0].slice(1);
    if (!['tableofcontents', 'maketitle', 'frontmatter', 'mainmatter', 'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'input', 'include', 'subfile', 'appendix', 'bibliography', 'printbibliography', 'addcontentsline', 'begin', 'end'].includes(command)) continue;
    const at = match.index, after = at + match[0].length;
    if (!active(at)) continue;
    if (command === 'tableofcontents') {
      existing ??= at;
    } else if (['input', 'include', 'subfile', 'begin', 'end'].includes(command)) {
      const argument = /^\s*\{([^{}\\#\r\n]+)\}/.exec(source.slice(after));
      if (!argument) continue;
      const stop = after + argument[0].length;
      const name = argument[1].trim();
      if (command === 'begin' && name === 'appendices') features.add('appendices');
      else if (command === 'begin' && name === 'thebibliography') features.add('bibliography');
      else if (command === 'end' && name === 'titlepage') commands.push(stop);
      else if (command !== 'begin' && command !== 'end') includes.push({ path: name, end: stop });
    } else if (command === 'maketitle' || command === 'frontmatter') {
      commands.push(after);
    } else if (['appendix', 'bibliography', 'printbibliography'].includes(command)) {
      if (command !== 'printbibliography' || !/^\s*\[[^\]]*\bheading\s*=\s*(?:bibintoc|subbibintoc|bibnumbered|subbibnumbered)\b/.test(source.slice(after))) features.add(command);
    } else if (command === 'addcontentsline') {
      const entry = /^\s*\{toc\}\s*\{[^{}]+\}\s*\{([^\n]*)/.exec(source.slice(after))?.[1] || '';
      if (/abstractname|摘要|abstract/i.test(entry)) features.add('manualAbstract');
      if (/refname|bibname|参考文献|references|bibliography/i.test(entry)) features.add('manualBibliography');
      if (/appendixname|附录|appendix/i.test(entry)) features.add('manualAppendix');
    } else {
      firstSection = Math.min(firstSection, at);
    }
  }
  let anchor = lower;
  for (const position of [...abstractEnds, ...commands]) if (position <= firstSection && position > anchor) anchor = position;
  const hasAbstract = abstractEnds.some(position => position > lower && position <= upper);
  if (hasAbstract) features.add('abstract');
  return { existing, anchor, firstSection, includes, hasAbstract, begin, features };
}

function contentsInsertion(source, anchor) {
  const newline = source.indexOf('\n', anchor);
  const lineEnd = newline === -1 ? source.length : newline;
  if (/^[ \t]*(?:%[^\r\n]*)?$/.test(source.slice(anchor, lineEnd))) anchor = lineEnd;
  const text = (anchor > 0 && source[anchor - 1] !== '\n' ? '\n' : '') + '\\tableofcontents\n' +
    (anchor < source.length && source[anchor] !== '\n' ? '\n' : '');
  return { at: anchor, text };
}

function contentsSetup(source, begin, features) {
  const marker = '% DSH contents setup';
  const closing = '% End DSH contents setup';
  const managed = new RegExp('^' + marker + '\\n[\\s\\S]*?^' + closing + '(?:\\n|$)', 'm').exec(source);
  const lines = [marker, '\\AddToHook{cmd/tableofcontents/before}[dsh/contents]{\\setcounter{tocdepth}{3}}'];
  const entries = [];
  if (features.has('abstract') && !features.has('manualAbstract')) {
    entries.push('\\AddToHook{cmd/abstract/after}[dsh/contents]{\\dshcontentsentry{\\abstractname}}');
  }
  if (features.has('printbibliography') && !features.has('manualBibliography')) {
    entries.push('\\AtBeginBibliography{\\dshcontentsentry{\\ifdefined\\chapter\\bibname\\else\\refname\\fi}}');
  }
  if (!features.has('manualAppendix')) {
    if (features.has('appendix')) entries.push('\\AddToHook{cmd/appendix/after}[dsh/contents]{\\ifdefined\\chapter\\cleardoublepage\\fi\\dshcontentsentry{\\appendixname}}');
    else if (features.has('appendices')) entries.push('\\AddToHook{env/appendices/begin}[dsh/contents]{\\ifdefined\\chapter\\cleardoublepage\\fi\\dshcontentsentry{\\appendixname}}');
  }
  if (features.has('bibliography') && !features.has('printbibliography') && !features.has('manualBibliography') && !packagePlan(source.replace(managed?.[0] || '\0', ''), 'tocbibind').loaded) {
    lines.push('\\usepackage[nottoc,notlot,notlof,notindex]{tocbibind}');
  }
  if (entries.length) {
    lines.push('\\providecommand{\\dshcontentsentry}[1]{%', '  \\ifdefined\\phantomsection\\phantomsection\\fi',
      '  \\ifdefined\\chapter\\addcontentsline{toc}{chapter}{#1}\\else\\addcontentsline{toc}{section}{#1}\\fi}', ...entries);
  }
  const from = managed?.index ?? begin;
  const insert = (from > 0 && source[from - 1] !== '\n' ? '\n' : '') + [...lines, closing, ''].join('\n');
  if (managed?.[0] === insert || (managed && managed[0] === insert.trimStart())) return null;
  return { from, to: managed ? from + managed[0].length : from, insert };
}

export async function planProjectContents(mainFile, files, readFile, configure = false) {
  const paths = new Set(files);
  const visited = new Map();
  const features = new Set();
  function resolve(owner, include) {
    if (!include || /[:\\]/.test(include) || include.startsWith('/')) return null;
    const name = /\.[^/]+$/.test(include) ? include : include + '.tex';
    for (const prefix of ['', owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/') + 1) : '']) {
      const parts = [];
      for (const part of (prefix + name).split('/')) {
        if (part === '..') {
          if (!parts.length) { parts.push('..'); break; }
          parts.pop();
        } else if (part && part !== '.') parts.push(part);
      }
      const candidate = parts.join('/');
      if (paths.has(candidate)) return candidate;
    }
    return null;
  }
  async function visit(path) {
    if (visited.has(path)) return visited.get(path);
    visited.set(path, null);
    const { content, hash } = await readFile(path);
    const source = content.replace(/\r\n?/g, '\n');
    const info = contentsInfo(source, path === mainFile);
    if (!info) return null;
    const snapshot = { path, hash };
    for (const feature of info.features) features.add(feature);
    let existing = info.existing !== null ? { ...snapshot, at: info.existing } : null;
    if (!configure && existing) return existing;
    let anchor = info.anchor, hasAbstract = info.hasAbstract;
    for (const entry of info.includes) {
      const childPath = resolve(path, entry.path);
      if (!childPath) continue;
      const child = await visit(childPath);
      if (!child) continue;
      if (!configure && child.at !== undefined) return child;
      if (child.existing) existing ??= child.existing;
      if (child.hasAbstract && entry.end <= info.firstSection) {
        anchor = Math.max(anchor, entry.end);
        hasAbstract = true;
      }
    }
    const result = path === mainFile ? (existing || { ...snapshot, ...contentsInsertion(source, anchor) }) : { hasAbstract, existing };
    if (configure && path === mainFile) {
      const change = contentsSetup(source, info.begin, features);
      if (change) result.setup = { ...snapshot, change };
    }
    visited.set(path, result);
    return result;
  }
  return visit(mainFile);
}

export function packagePlan(source, packageName) {
  const { begin } = scanSource(source, false);
  if (begin == null) return { loaded: false, at: null };
  const preamble = source.slice(0, begin).replace(/\\[^\r\n]|%[^\r\n]*/g, part => part.startsWith('%') ? '' : part);
  for (const match of preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
    if (match[1].split(',').some(name => name.trim() === packageName)) return { loaded: true, at: null };
  }
  return { loaded: false, at: begin };
}

export const graphicxPlan = source => packagePlan(source, 'graphicx');

export function normalizeFormula(value) {
  let formula = value.trim();
  const fence = /^```(?:latex|tex)?[ \t]*\r?\n([\s\S]+?)\r?\n```$/i.exec(formula);
  if (fence) formula = fence[1].trim();
  const wrapped = /^(?:\\\[([\s\S]*)\\\]|\\\(([\s\S]*)\\\)|\$\$([\s\S]*)\$\$|\$([^$]*)\$|\\begin\{equation\*?\}([\s\S]*)\\end\{equation\*?\})$/.exec(formula);
  if (wrapped) formula = wrapped.slice(1).find(value => value !== undefined).trim();
  if (!formula || formula.length > 4000 || /\n\s*\n|(?<!\\)[%$]|\^\^|\\(?:end|begin)\s*\{(?!aligned\}|gathered\}|matrix\}|pmatrix\}|bmatrix\}|Bmatrix\}|vmatrix\}|Vmatrix\}|smallmatrix\}|cases\})|\\(?:[A-Za-z]*def|(?:re|provide)?newcommand|providecommand|let|futurelet|csname|catcode|write|input|include|read|openin|openout|directlua|latelua|special|immediate|usepackage|verb)\b/i.test(formula)) return '';
  return formula;
}

export function templateFragment(source, kind, lang = 'zh', main = false) {
  if (kind === 'preamble') {
    const plans = ['amsmath', 'graphicx', 'booktabs'].map(name => ({ name, ...packagePlan(source, name) }));
    const missing = plans.filter(plan => plan.at != null);
    if (!main || !missing.length) return null;
    return { at: missing[0].at, text: missing.map(plan => '\\usepackage{' + plan.name + '}').join('\n') };
  }
  const chinese = lang === 'zh';
  if (kind === 'abstract') {
    if (/\\begin\s*\{abstract\}/.test(source.replace(/(^|[^\\])%[^\r\n]*/g, '$1'))) return null;
    return { text: '\\begin{abstract}\n% ' + (chinese ? '在这里写摘要。' : 'Write your abstract here.') + '\n\\end{abstract}' };
  }
  if (kind === 'sections') {
    const headings = chinese ? ['引言', '研究方法', '结果与讨论', '结论'] : ['Introduction', 'Methods', 'Results and Discussion', 'Conclusion'];
    const clean = source.replace(/(^|[^\\])%[^\r\n]*/g, '$1');
    const missing = headings.filter(heading => !clean.includes('\\section{' + heading + '}'));
    return missing.length ? { text: missing.map(heading => '\\section{' + heading + '}\n').join('\n').trimEnd() } : null;
  }
  return null;
}

export function insertionPosition(source, { from, to }, { main, action }) {
  const floats = action === 'figure' || action === 'table';
  const inline = ['bold', 'italic', 'underline', 'mono'].includes(action);
  const { start, end, spans } = scanSource(source, floats);
  if (main && start == null) return { reason: 'insertNoBody' };
  const left = start ?? 0, right = end ?? source.length;
  const blocked = (a, b) => spans.find(span => (!inline || span.reason !== 'inline') && a < span.to && b > span.from);
  const hit = blocked(from, to);
  const reason = from < left ? 'insertPreamble' : to > right ? 'insertAfterBody' : hit?.reason;
  if (!reason) return {};
  const tryPositions = [left, right].filter(position => position >= left && position <= right && !blocked(position, position));
  tryPositions.sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
  return { reason: reason === 'inline' ? 'insertGroup' : reason, jump: tryPositions[0] };
}
