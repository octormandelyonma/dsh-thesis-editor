import { latexStructureTokens, literalEnvironments } from './latex-indent.js';

const sections = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
const commands = {
  documentclass: '选择文档类型与基本版式', usepackage: '加载 LaTeX 宏包', ctexset: '设置中文排版与章节格式',
  title: '设置论文标题', author: '设置作者', date: '设置日期', maketitle: '生成论文标题区',
  tableofcontents: '生成目录', geometry: '设置纸张和页边距', pagestyle: '设置页眉页脚样式',
  part: '开始一个篇章', chapter: '开始一章', section: '开始一节', subsection: '开始一个小节',
  subsubsection: '开始下一级小节', paragraph: '添加段落标题', subparagraph: '添加下一级段落标题',
  caption: '设置图表标题', label: '设置交叉引用标签', cite: '引用参考文献',
  ref: '引用章节、图表或其他编号', eqref: '引用公式编号', includegraphics: '插入图片',
  input: '插入另一个源码文件', include: '引入单独的章节文件',
  bibliography: '指定参考文献文件', addbibresource: '添加参考文献数据源',
  bibliographystyle: '设置参考文献样式', printbibliography: '输出参考文献列表',
  toprule: '绘制三线表顶线', midrule: '绘制三线表中线', bottomrule: '绘制三线表底线',
  textbf: '加粗文字', textit: '设置斜体', underline: '为文字加下划线', texttt: '设置等宽字体',
  item: '添加一条列表项', centering: '将当前内容居中', hline: '绘制表格横线', footnote: '添加脚注',
  newcommand: '定义一个 LaTeX 命令', renewcommand: '重新定义一个 LaTeX 命令'
};
const environments = {
  document: '开始文档内容', abstract: '撰写论文摘要', figure: '设置插图及其位置',
  table: '设置表格及其位置', tabular: '定义表格行列', tabularx: '定义指定宽度的表格',
  itemize: '创建无序列表', enumerate: '创建编号列表', description: '创建术语说明列表',
  equation: '编排独立公式', align: '对齐多行公式', gather: '居中排版多行公式',
  multline: '分行排版一个长公式', cases: '排版分段表达式', matrix: '排版矩阵',
  quote: '排版独立引用段落', theorem: '陈述定理', proof: '撰写证明',
  verbatim: '按原样显示文本', lstlisting: '显示代码清单', minted: '显示代码清单', comment: '忽略此处的内容'
};
const cache = new WeakMap();

export function latexOutline(doc) {
  const cached = cache.get(doc);
  if (cached) return cached;
  const folds = new Map();
  const hints = new Map();
  const blocks = [];
  const headings = [];
  let preamble = null, literal = null;
  const addFold = (opening, end) => {
    if (end <= opening.to || end <= (folds.get(opening.from)?.to ?? -1)) return;
    folds.set(opening.from, { from: opening.to, to: end });
  };
  let from = 0;
  for (const text of doc.iterLines()) {
    const line = { from, to: from + text.length };
    from = line.to + 1;
    const end = line.from - 1;
    if (literal) {
      if (text.trimStart().startsWith('\\end{' + literal.name + '}')) {
        addFold(literal.line, end);
        literal = null;
      }
      continue;
    }
    let hint = '';
    const first = text.search(/\S/);
    for (const match of text.matchAll(latexStructureTokens)) {
      const [token, verb, direction, name] = match;
      if (token.startsWith('%')) break;
      if (verb) continue;
      const command = token.slice(1);
      const atStart = match.index === first;
      if (direction === 'begin') {
        if (atStart) {
          const base = name.replace(/\*$/, '');
          hint = Object.hasOwn(environments, base) ? environments[base] : '开始 ' + name + ' 环境';
        }
        if (name === 'document') {
          if (preamble) addFold(preamble, end);
          preamble = null;
        }
        if (literalEnvironments.has(name)) {
          if (!text.includes('\\end{' + name + '}', match.index + token.length)) literal = { line, name };
          break;
        }
        blocks.push({ key: 'environment:' + name, line });
      } else if (token === '{' || token === '\\[' || direction === 'end' || token === '}' || token === '\\]') {
        if (token === '{' || token === '\\[') {
          blocks.push({ key: token === '{' ? '}' : '\\]', line });
          if (token === '\\[' && atStart) hint = '排版行间公式';
        } else {
          const key = direction === 'end' ? 'environment:' + name : token;
          const open = blocks.at(-1);
          if (open?.key === key) {
            blocks.pop();
            if (key !== 'environment:document') addFold(open.line, end);
          }
          if (direction === 'end' && name === 'document') {
            while (headings.length) addFold(headings.pop().line, end);
          }
        }
      } else if (atStart && Object.hasOwn(commands, command)) {
        hint = commands[command];
        if (command === 'documentclass') preamble = line;
        const rank = sections.indexOf(command);
        if (rank !== -1) {
          while (headings.length && headings.at(-1).rank >= rank) addFold(headings.pop().line, end);
          headings.push({ line, rank });
        }
      }
    }
    if (hint) hints.set(line.from, hint);
  }
  while (headings.length) addFold(headings.pop().line, doc.length);
  const outline = { folds, hints };
  cache.set(doc, outline);
  return outline;
}
