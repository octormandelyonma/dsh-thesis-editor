import { COLUMN_LIMIT, ROW_LIMIT, rectangularTable } from './format-tools.js';
import { readZip } from './import.js';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false;
  function addCell() {
    row.push(cell);
    if (row.length > COLUMN_LIMIT || cell.length > 500) throw new Error('TABLE_SIZE');
    cell = '';
    closed = false;
  }
  function addRow() {
    addCell();
    rows.push(row);
    if (rows.length > ROW_LIMIT) throw new Error('TABLE_SIZE');
    row = [];
  }
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === ',') {
      addCell();
    } else if (char === '\r' || char === '\n') {
      addRow();
      if (char === '\r' && source[index + 1] === '\n') index++;
    } else if (char === '"' && !cell && !closed) {
      quoted = true;
    } else {
      if (closed || char === '"') throw new Error('TABLE_FORMAT');
      cell += char;
    }
    if (cell.length > 500) throw new Error('TABLE_SIZE');
  }
  if (quoted) throw new Error('TABLE_FORMAT');
  if (row.length || cell || closed) addRow();
  const grid = rectangularTable(rows);
  if (!grid) throw new Error('TABLE_SIZE');
  return grid;
}

const nodeChildren = (node, name) => Array.from(node?.children || []).filter(item => item.localName === name);
const child = (node, name) => nodeChildren(node, name)[0];
const stringValue = node => nodeChildren(node, 't').concat(nodeChildren(node, 'r').flatMap(run => nodeChildren(run, 't'))).map(part => part.textContent).join('');
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function importTableFile(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error('TABLE_SIZE');
  if (/\.csv$/i.test(file.name)) return parseCsv(decoder.decode(await file.arrayBuffer()));
  if (!/\.xlsx$/i.test(file.name)) throw new Error('TABLE_FORMAT');
  const entries = await readZip(await file.arrayBuffer(), {
    include: name => /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name),
    maxBytes: 20 * 1024 * 1024
  });
  function xml(path, optional = false) {
    const item = entries.find(entry => entry.path === path);
    if (!item && optional) return null;
    if (!item) throw new Error('TABLE_FORMAT');
    const text = decoder.decode(item.data);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('TABLE_FORMAT');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('TABLE_FORMAT');
    return doc.documentElement;
  }
  const sheet = nodeChildren(child(xml('xl/workbook.xml'), 'sheets'), 'sheet').find(item => !['hidden', 'veryHidden'].includes(item.getAttribute('state')));
  const id = Array.from(sheet?.attributes || []).find(item => item.localName === 'id')?.value;
  const target = nodeChildren(xml('xl/_rels/workbook.xml.rels'), 'Relationship').find(item => item.getAttribute('Id') === id)?.getAttribute('Target');
  if (!target || !/^\/?(?:xl\/)?worksheets\/[A-Za-z0-9_.-]+\.xml$/.test(target)) throw new Error('TABLE_FORMAT');
  const worksheet = xml('xl/' + target.replace(/^\/?(?:xl\/)?/, ''));
  if (child(worksheet, 'mergeCells')) throw new Error('TABLE_MERGED');
  const strings = nodeChildren(xml('xl/sharedStrings.xml', true), 'si');
  const rows = [];
  let firstRow = null;
  for (const item of nodeChildren(child(worksheet, 'sheetData'), 'row')) {
    const index = Number(item.getAttribute('r'));
    for (const cell of nodeChildren(item, 'c')) {
      const value = child(cell, 'v');
      const inline = child(cell, 'is');
      if (!value && !inline) {
        if (child(cell, 'f')) throw new Error('TABLE_FORMULA');
        continue;
      }
      const address = /^([A-Z]+)[1-9]\d*$/.exec(cell.getAttribute('r') || '');
      if (!address || !Number.isSafeInteger(index) || index < 1) throw new Error('TABLE_FORMAT');
      const column = Array.from(address[1]).reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      firstRow ??= index;
      const row = index - firstRow;
      if (row >= ROW_LIMIT || row < 0 || column >= COLUMN_LIMIT) throw new Error('TABLE_SIZE');
      const type = cell.getAttribute('t');
      if (type === 'e') throw new Error('TABLE_FORMULA');
      const valueText = value?.textContent || '';
      if (child(cell, 'f') && !valueText) throw new Error('TABLE_FORMULA');
      if (type === 's' && (!/^\d+$/.test(valueText) || !strings[Number(valueText)])) throw new Error('TABLE_FORMAT');
      const data = type === 's' ? stringValue(strings[Number(valueText)]) : inline ? stringValue(inline)
        : type === 'b' ? (valueText === '1' ? 'TRUE' : 'FALSE') : valueText;
      (rows[row] ??= [])[column] = data;
    }
  }
  const grid = rectangularTable(Array.from(rows, row => row || []));
  if (!grid) throw new Error('TABLE_SIZE');
  return grid;
}
