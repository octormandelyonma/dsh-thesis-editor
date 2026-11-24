import fs from 'node:fs/promises';
import path from 'node:path';

const issue = (code, file, line, message) => ({ code, level: 'warning', file, line, message });

export async function inspectStructure(root, mainFile) {
  const problems = [];
  const visited = new Set();
  const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
  async function visit(file) {
    if (visited.has(file) || visited.size >= 100) return;
    visited.add(file);
    const source = await fs.readFile(path.join(root, file), 'utf8').catch(() => null);
    if (source == null) return;
    const text = source.replace(/\\begin\s*\{(verbatim\*?|lstlisting|minted)\}[\s\S]*?\\end\s*\{\1\}|\\verb\*?([^\s])[^\r\n]*?\2|\\.|%[^\r\n]*/g,
      value => value.startsWith('%') || value.length > 2 ? value.replace(/[^\r\n]/g, ' ') : value);
    const end = file === mainFile ? /\\end\s*\{document\}/.exec(text) : null;
    if (end) {
      const rest = text.slice(end.index + end[0].length);
      const next = rest.search(/\S/);
      if (next >= 0) problems.push(issue('IGNORED_TAIL', file, lineAt(text, end.index + end[0].length + next), 'Text after \\end{document} is ignored by TeX.'));
    }
    const active = end ? text.slice(0, end.index) : text;
    for (const match of active.matchAll(/\\(input|include|subfile)\s*\{([^{}\\#]+)\}/g)) {
      const value = match[2].trim();
      if (!value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) continue;
      const name = path.posix.extname(value) ? value : value + '.tex';
      const candidates = [name, path.posix.join(path.posix.dirname(file), name)].map(candidate => path.posix.normalize(candidate)).filter(candidate => !candidate.startsWith('../') && !candidate.split('/').some(part => part.startsWith('.')));
      const resolved = await findFile(root, candidates);
      if (resolved) await visit(resolved);
      else problems.push(issue('MISSING_SOURCE', file, lineAt(active, match.index), 'Included TeX file was not found: ' + value));
    }
  }
  await visit(mainFile);
  return problems;
}

async function findFile(root, candidates) {
  for (const candidate of candidates) {
    const found = await fs.stat(path.join(root, candidate)).catch(() => null);
    if (found?.isFile()) return candidate;
  }
  return null;
}

export function diagnosticCode(problem) {
  if (problem.code) return problem.code;
  const message = problem.message;
  if (/file .*not found|cannot find file|couldn't open|cannot find .*file|not found on input line/i.test(message)) return 'MISSING_RESOURCE';
  if (/citation.+undefined|undefined citations|didn't find a database entry|cite keys?.*not found/i.test(message)) return 'UNDEFINED_CITATION';
  if (/reference.+undefined|undefined references/i.test(message)) return 'UNDEFINED_REFERENCE';
  if (/runaway argument|extra \}|missing \}|file ended while scanning|forgotten \}/i.test(message)) return 'UNBALANCED_GROUP';
  if (/ended by \\end|unknown environment|environment .* undefined/i.test(message)) return 'ENVIRONMENT';
  if (/fontspec.*error|font .*cannot be found|font .*not loadable/i.test(message)) return 'FONT';
  if (/undefined control sequence/i.test(message)) return 'UNDEFINED_CONTROL_SEQUENCE';
  if (/timed out/i.test(message)) return 'TIMEOUT';
  return problem.level === 'error' ? 'TEX_ERROR' : 'TEX_WARNING';
}

export function relevantIssues(problems) {
  return problems.map(problem => ({ ...problem, code: diagnosticCode(problem) }));
}

export function blockingIssue(problem) {
  return problem.level === 'error' || ['IGNORED_TAIL', 'MISSING_SOURCE', 'MISSING_RESOURCE', 'UNDEFINED_CITATION', 'UNDEFINED_REFERENCE'].includes(problem.code);
}
