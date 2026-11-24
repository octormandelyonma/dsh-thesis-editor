import { scanSource } from './format-tools.js';

const sourceSuffix = /\.(?:tex|bib)$/i;
const groupArgument = /^\s*(?:\[(?:[^\][\n]|\[[^\]\n]*\])*\]\s*)*\{((?:[^{}]|\{[^{}]*\})*)\}/;
const levels = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
const cite = /^(?:no|paren|text|auto|foot|super|smart|full|footfull|capital)?cite(?:p|t|alp|alt|author|year|yearpar|s)?$/i;
const reference = /^(?:page|eq|auto|[cC]|name|v)?ref$/i;

export function projectPath(paths, owner, target, extension) {
  if (!target || /^\/|[:\\#]/.test(target)) return null;
  const filename = /\.[^/]+$/.test(target) ? target : target + extension;
  const folder = owner.split('/').slice(0, -1);
  for (const prefix of [[], folder]) {
    const parts = [...prefix];
    for (const part of filename.split('/')) {
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

export function analyzeTex(path, content) {
  const source = content.replace(/\r\n?/g, '\n');
  const { end, spans } = scanSource(source, false);
  const opaque = spans.filter(span => span.reason === 'insertComment' || span.reason === 'insertLiteral').sort((a, b) => a.from - b.from);
  const result = { path, headings: [], includes: [], bibResources: [], cites: [], bibitems: [], labels: [], refs: [] };
  let line = 1, cursor = 0, ignored = 0;
  for (const match of source.matchAll(/\\([A-Za-z@]+)\*?|\\[^\n]/g)) {
    const at = match.index, command = match[1], level = levels.indexOf(command);
    if (end != null && at >= end) break;
    while (ignored < opaque.length && opaque[ignored].to <= at) ignored++;
    if (opaque[ignored]?.from <= at) continue;
    const field = level >= 0 ? 'headings'
      : ['input', 'include', 'subfile'].includes(command) ? 'includes'
        : ['bibliography', 'addbibresource'].includes(command) ? 'bibResources'
          : cite.test(command) ? 'cites' : reference.test(command) ? 'refs'
            : command === 'bibitem' ? 'bibitems' : command === 'label' ? 'labels' : '';
    if (!field) continue;
    let argument = groupArgument.exec(source.slice(at + match[0].length));
    if (!argument) continue;
    for (; cursor < at; cursor++) if (source[cursor] === '\n') line++;
    if (field === 'headings') {
      result.headings.push({ path, line, level, label: argument[1].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() });
      continue;
    }
    let offset = at + match[0].length;
    do {
      for (const part of argument[1].split(',')) {
        const key = part.trim();
        if (key && key !== '*' && !/[\\{}#]/.test(key)) result[field].push({ path, line, key });
      }
      offset += argument[0].length;
      if (field !== 'cites' || !/cites$/i.test(command)) break;
      argument = groupArgument.exec(source.slice(offset));
    } while (argument);
  }
  return result;
}

export function analyzeBib(path, source) {
  const entries = [];
  const text = source.replace(/\r\n?/g, '\n');
  const tokens = /(?:^|\n)[ \t]*%[^\n]*|@([A-Za-z]+)\s*([{(])|\\[^\n]|[{}()"\n]/g;
  let line = 1, tail = '', braces = 0, quoted = false;
  for (const match of text.matchAll(tokens)) {
    const value = match[0], type = match[1]?.toLowerCase(), delimiter = match[2];
    if (value.startsWith('\n')) line++;
    if (!tail) {
      if (!delimiter) continue;
      tail = delimiter === '{' ? '}' : ')';
      const key = /^\s*([^\s,{}()]+)\s*,/.exec(text.slice(match.index + value.length))?.[1];
      if (key && !['string', 'comment', 'preamble'].includes(type)) entries.push({ path, line, key });
      line += value.split('\n').length - 1;
    } else if (delimiter) {
      if (!quoted && delimiter === '{') braces++;
      line += value.split('\n').length - 1;
    } else if (value === '"' && !braces) quoted = !quoted;
    else if (!quoted && value === '{') braces++;
    else if (!quoted && value === '}' && braces) braces--;
    else if (!quoted && !braces && value === tail) tail = '';
  }
  return entries;
}

export function projectOutline(sources, mainFile) {
  const seen = new Set(), files = [];
  function visit(file) {
    if (!sources.has(file) || seen.has(file)) return;
    seen.add(file);
    const entry = sources.get(file);
    if (entry.headings.length) files.push(entry);
    for (const item of entry.includes) visit(projectPath(sources, file, item.key, '.tex'));
  }
  visit(mainFile);
  for (const file of sources.keys()) visit(file);
  return files;
}

export function outlineTree(headings) {
  const roots = [], ancestors = [];
  for (const heading of headings) {
    const node = { ...heading, children: [] };
    while (ancestors.length && ancestors.at(-1).level >= heading.level) ancestors.pop();
    (ancestors.at(-1)?.children || roots).push(node);
    ancestors.push(node);
  }
  return roots;
}

export function referenceIssues(sources, bibliographies, mainFile) {
  const scoped = new Map();
  function visit(file) {
    const source = sources.get(file);
    if (!source || scoped.has(file)) return;
    scoped.set(file, source);
    for (const item of source.includes) visit(projectPath(sources, file, item.key, '.tex'));
  }
  visit(mainFile);
  const active = [...scoped.values()];
  const declared = active.flatMap(item => item.bibResources);
  const linked = new Set(declared.map(item => projectPath(bibliographies, item.path, item.key, '.bib')).filter(Boolean));
  const issues = declared.filter(item => !projectPath(bibliographies, item.path, item.key, '.bib'))
    .map(item => ({ ...item, kind: 'missingBibliography' }));
  function inspect(definitions, uses, missing, duplicate) {
    const index = new Map();
    for (const item of definitions) {
      const matches = index.get(item.key) || [];
      matches.push(item);
      index.set(item.key, matches);
    }
    for (const matches of index.values()) if (matches.length > 1) for (const item of matches) issues.push({ ...item, kind: duplicate });
    for (const item of uses) if (!index.has(item.key)) issues.push({ ...item, kind: missing });
  }
  inspect([...active.flatMap(item => item.bibitems), ...[...linked].flatMap(file => bibliographies.get(file))],
    active.flatMap(item => item.cites), 'missingCitationKey', 'duplicateCitationKey');
  inspect(active.flatMap(item => item.labels), active.flatMap(item => item.refs), 'missingLabelKey', 'duplicateLabelKey');
  return issues;
}

export async function readProjectAnalysis(entries, mainFile, readFile) {
  const sources = new Map(), bibliographies = new Map();
  const files = entries.filter(file => file.kind === 'text' && sourceSuffix.test(file.path));
  // Keep the host's per-project RPC queue bounded for large imports.
  for (let i = 0; i < files.length; i += 8) {
    const batch = await Promise.all(files.slice(i, i + 8).map(async ({ path }) => ({ path, ...await readFile(path) })));
    for (const { path, content } of batch) {
      if (/\.bib$/i.test(path)) bibliographies.set(path, analyzeBib(path, content));
      else if (/\.tex$/i.test(path) || path === mainFile) sources.set(path, analyzeTex(path, content));
    }
  }
  return { sources, bibliographies };
}
