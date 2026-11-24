import dictionary from 'dictionary-en';
import nspell from 'nspell';

export const MAX_CHECK_LENGTH = 20000;
const MAX_ISSUES = 40;
const literalEnvs = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted']);
const mathEnvs = /^(?:math|displaymath|equation|align|alignat|flalign|gather|multline|eqnarray|split|aligned|matrix|[bBpPvV]matrix|cases)\*?$/;
const mathPairs = { '$': '$', '$$': '$$', '\\(': '\\)', '\\[': '\\]' };
const commandTypos = {
  begni: 'begin', documetclass: 'documentclass', usepakage: 'usepackage',
  includegrapics: 'includegraphics', inlcudegraphics: 'includegraphics',
  sectoin: 'section', subsecton: 'subsection', cetnering: 'centering'
};
const commonChineseTypos = {
  按装: '安装', 部暑: '部署', 统记分析: '统计分析', 统计分折: '统计分析',
  实验结国: '实验结果', 数据釆集: '数据采集', 误差分折: '误差分析',
  带宽瓶径: '带宽瓶颈', 换算系教: '换算系数',
  再接再励: '再接再厉', 一愁莫展: '一筹莫展', 迫不急待: '迫不及待'
};
const tokenPattern = /%[^\n]*|\\verb\*?([^\s*])[^\n]*?(?:\1|(?=\n|$))|\\(begin|end)\s*\{([^{}\n]+)\}|\\([A-Za-z@]+)\*?|\\[^\n]|\$\$|[$^_{}]/g;
const metadataCommands = /\\(?:documentclass|usepackage|RequirePackage|bibliography|bibliographystyle|addbibresource|(?:[a-z]*cite[a-z]*)|(?:[a-z]*ref)|label|input|include|includegraphics|url|path|pagestyle|thispagestyle|hspace|vspace)\*?(?=\s*[[{])(?:\s*\[[^\]\n]*\]){0,2}(?:\s*\{[^{}\n]*\})/gi;
const codeEnvs = /^(?:tabularx?|array|longtable|minipage|multicols)\*?$/;
let spell;

export function checkSource(source, { from, to }) {
  const problems = [];
  const opaque = [];
  const groups = [];
  const environments = [];
  let math = null;
  const add = (kind, start, end, replacements = [], detail = '') => {
    if (start < from || end > to || problems.length >= MAX_ISSUES) return;
    problems.push({ kind, from: start, to: end, text: source.slice(start, end), replacements, detail });
  };
  const mask = (start, end) => {
    if (start < to && end > from) opaque.push([Math.max(from, start) - from, Math.min(to, end) - from]);
  };
  const tokens = new RegExp(tokenPattern);
  let token;
  while ((token = tokens.exec(source))) {
    const [value, verb, direction, name, command] = token;
    const start = token.index, end = tokens.lastIndex;
    if (value.startsWith('%') || verb) { mask(start, end); continue; }
    if (direction) {
      mask(start, end);
      if (direction === 'begin') {
        if (literalEnvs.has(name)) {
          const close = source.indexOf('\\end{' + name + '}', end);
          if (close < 0) add('checkUnclosedEnvironment', start, end, [], name);
          tokens.lastIndex = close < 0 ? source.length : close + name.length + 6;
          mask(start, tokens.lastIndex);
        } else {
          environments.push({ name, start, end });
          if (name === 'document') mask(0, end);
          if (codeEnvs.test(name)) {
            const args = /^(?:[ \t]*\[[^\]\n]*\])?(?:[ \t]*\{[^{}\n]*\}){1,2}/.exec(source.slice(end));
            if (args) mask(end, end + args[0].length);
          }
        }
      } else {
        const open = environments.at(-1);
        if (open?.name === name) {
          environments.pop();
          if (mathEnvs.test(name)) mask(open.start, end);
        } else if (!open) {
          add('checkUnexpectedEnvironment', start, end, [], name);
        } else {
          const matching = environments.findLastIndex(item => item.name === name);
          if (matching >= 0) {
            const [closing, ...unclosed] = environments.splice(matching);
            for (const item of unclosed) {
              add('checkUnclosedEnvironment', item.start, item.end, [], item.name);
              if (mathEnvs.test(item.name)) mask(item.start, start);
            }
            if (mathEnvs.test(name)) mask(closing.start, end);
          } else {
            environments.pop();
            add('checkEnvironmentMismatch', start, end, ['\\end{' + open.name + '}'], open.name);
            if (mathEnvs.test(open.name)) mask(open.start, end);
          }
        }
      }
      continue;
    }
    if (value === math?.close) { mask(math.start, end); math = null; continue; }
    if (Object.hasOwn(mathPairs, value)) {
      if (!math) math = { start, end, close: mathPairs[value] };
      continue;
    }
    if (!math && (value === '\\)' || value === '\\]')) add('checkUnexpectedMath', start, end);
    if (command) {
      const replacement = Object.hasOwn(commandTypos, command) ? commandTypos[command] : '';
      if (replacement) add('checkCommandSpelling', start, end, ['\\' + replacement + (value.endsWith('*') ? '*' : '')]);
      mask(start, end);
    } else if (value === '{') groups.push(start);
    else if (value === '}') {
      if (groups.length) groups.pop();
      else add('checkUnexpectedBrace', start, end, ['']);
    }
  }
  for (const start of groups) add('checkUnclosedBrace', start, start + 1, [], '}');
  for (const open of environments) {
    add('checkUnclosedEnvironment', open.start, open.end, [], open.name);
    if (mathEnvs.test(open.name)) mask(open.start, source.length);
  }
  if (math) {
    add('checkUnclosedMath', math.start, math.end, [], math.close);
    mask(math.start, source.length);
  }
  for (const match of source.matchAll(metadataCommands)) mask(match.index, match.index + match[0].length);
  for (const match of source.matchAll(/(?:https?:\/\/|www\.)[^\s{}<>]+/g)) mask(match.index, match.index + match[0].length);

  const masked = source.slice(from, to).split('');
  for (const [start, end] of opaque) masked.fill(' ', start, end);
  const prose = masked.join('');
  for (const match of prose.matchAll(new RegExp(Object.keys(commonChineseTypos).join('|'), 'g'))) {
    const start = from + match.index;
    add('checkSpelling', start, start + match[0].length, [commonChineseTypos[match[0]]]);
  }
  const suggestions = new Map();
  for (const match of prose.matchAll(/[A-Za-z][A-Za-z'’]*/g)) {
    const word = match[0].replace(/['’]+$/, '');
    const start = from + match.index, end = start + word.length;
    if (problems.length >= MAX_ISSUES) break;
    if (word.length < 3 || word.length > 30 || /[A-Z]/.test(word.slice(1)) ||
        /[A-Za-z0-9_'’]/.test(source[start - 1] || '') || /[A-Za-z0-9_'’]/.test(source[end] || '')) continue;
    spell ??= nspell(dictionary);
    if (spell.correct(word) || spell.correct(word.toLowerCase())) continue;
    if (!suggestions.has(word)) suggestions.set(word, spell.suggest(word).slice(0, 4));
    add('checkSpelling', start, end, suggestions.get(word));
  }
  return { problems: problems.sort((a, b) => a.from - b.from), limited: problems.length >= MAX_ISSUES };
}
