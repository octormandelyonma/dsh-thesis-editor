import React, { useEffect, useRef, useState } from 'react';
import { EditorSelection } from '@codemirror/state';
import { COLUMN_LIMIT, ROW_LIMIT, figureSource, parsePastedTable, tableSource, validImage, validLabel } from './format-tools.js';
import { importTableFile } from './table-import.js';

const bibliographyPattern = /@(\w+)\s*[{(]\s*([^,\s]+)\s*,/g;

export function insertThesisFormat(view, kind, data, actions) {
  if (kind === 'heading') return actions[data.command].run(view);
  const { from, to } = view.state.selection.main;
  const text = kind === 'cite' ? '\\cite{' + data.key + '}'
    : kind === 'figure' ? figureSource(data) : kind === 'table' ? tableSource(data)
      : kind === 'equation' ? (data.numbered ? '\n\\begin{equation}\n  ' + data.formula + '\n\\end{equation}\n' : '\n\\[\n  ' + data.formula + '\n\\]\n')
        : '\n' + data.text + '\n';
  const start = kind === 'cite' ? from : to;
  if (kind === 'template' && data.at != null) {
    view.dispatch({ changes: { from: data.at, insert: text }, selection: EditorSelection.cursor(data.at + text.length), scrollIntoView: true, userEvent: 'input.format' });
    return;
  }
  const changes = [];
  let shift = 0;
  if (data.packageAt != null) {
    const prefix = view.state.sliceDoc(Math.max(0, data.packageAt - 1), data.packageAt) === '\n' ? '' : '\n';
    const declaration = prefix + '\\usepackage{' + data.packageName + '}\n';
    changes.push({ from: data.packageAt, insert: declaration });
    shift = declaration.length;
  }
  changes.push({ from: start, to, insert: text });
  view.dispatch({ changes, selection: EditorSelection.cursor(start + shift + text.length), scrollIntoView: true, userEvent: 'input.format' });
}

function TableGrid({ t, cells, align, setGrid, setError, importing, setImporting }) {
  const spreadsheet = useRef(null);
  const [imported, setImported] = useState('');
  const paste = event => {
    const text = event.clipboardData.getData('text/plain');
    if (!/[\r\n\t]/.test(text)) return;
    event.preventDefault();
    const next = parsePastedTable(text);
    if (!next) { setError(t('tablePasteInvalid')); return; }
    setGrid(next, next[0].map((_, column) => align[column] || 'l'));
  };
  async function load(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || importing) return;
    setImporting(true);
    try {
      const next = await importTableFile(file);
      setGrid(next, next[0].map((_, column) => align[column] || 'l'));
      setImported(file.name);
    } catch (error) {
      setError(t(({ TABLE_SIZE: 'tablePasteInvalid', TABLE_MERGED: 'tableMerged', TABLE_FORMULA: 'tableFormula' })[error.message] || 'tableImportError'));
    } finally { setImporting(false); }
  }
  return <section className="thesis-grid-editor">
    <div className="thesis-grid-toolbar">
      <span>{t('tableFirstHeader')}</span>
      <div>
        <button type="button" className="fo-btn is-small" disabled={importing} onClick={() => spreadsheet.current?.click()}>{t(importing ? 'loading' : 'tableImport')}</button>
        <input type="file" ref={spreadsheet} hidden accept=".xlsx,.csv" aria-label={t('tableImport')} onChange={load} />
        <button type="button" className="fo-btn is-small" disabled={cells.length >= ROW_LIMIT}
          onClick={() => setGrid([...cells, align.map(() => '')], align)}>{t('tableAddRow')}</button>
        <button type="button" className="fo-btn is-small" disabled={align.length >= COLUMN_LIMIT}
          onClick={() => setGrid(cells.map(row => [...row, '']), [...align, 'l'])}>{t('tableAddColumn')}</button>
        <button type="button" className="fo-btn is-small" disabled={cells.length <= 2}
          onClick={() => setGrid(cells.slice(0, -1), align)}>{t('tableRemoveRow')}</button>
        <button type="button" className="fo-btn is-small" disabled={align.length <= 1}
          onClick={() => setGrid(cells.map(row => row.slice(0, -1)), align.slice(0, -1))}>{t('tableRemoveColumn')}</button>
      </div>
    </div>
    <div className="thesis-grid-scroll">
      <table aria-label={t('tableCells')}>
        <thead><tr><th scope="col">{t('tableAlign')}</th>{align.map((value, column) =>
          <th scope="col" key={column}><select aria-label={t('tableAlign') + ' ' + (column + 1)} value={value}
            onChange={event => setGrid(cells, align.map((old, index) => index === column ? event.target.value : old))}>
            <option value="l">{t('tableAlignLeft')}</option><option value="c">{t('tableAlignCenter')}</option><option value="r">{t('tableAlignRight')}</option>
          </select></th>)}</tr></thead>
        <tbody>{cells.map((row, rowIndex) => <tr key={rowIndex}>
          <th scope="row">{rowIndex === 0 ? t('tableHeader') : rowIndex}</th>
          {row.map((value, column) => <td key={column}>
            <input aria-label={(rowIndex === 0 ? t('tableHeader') : t('tableRow') + ' ' + rowIndex) + ' · ' + t('tableColumn') + ' ' + (column + 1)}
              autoFocus={rowIndex === 0 && column === 0} value={value} onPaste={paste} maxLength={500}
              onChange={event => setGrid(cells.map((old, index) => index === rowIndex ? old.map((cell, col) => col === column ? event.target.value : cell) : old), align)} />
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <p className="fo-dialog-copy">{t('tableGridPaste')}</p>
    {imported && <p className="fo-dialog-copy">{imported} · {t('tableValuesOnly')}</p>}
  </section>;
}

export function FormatDialog({ kind, t, files, readBib, imageUrl, uploadImage, graphicx, booktabs, onClose, onInsert, Dialog }) {
  const [form, setForm] = useState({ command: 'section', caption: '', label: '', image: '', key: '', width: '80', placement: 'htbp', addPackage: true });
  const [cells, setCells] = useState([['', '', ''], ['', '', '']]);
  const [align, setAlign] = useState(['l', 'l', 'l']);
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(kind === 'cite');
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const filePicker = useRef(null);
  const [error, setError] = useState('');
  const images = files.filter(item => validImage(item.path));
  useEffect(() => {
    if (kind !== 'cite') return;
    let active = true;
    Promise.all(files.filter(item => item.path.endsWith('.bib') && item.kind === 'text').map(item => readBib(item.path)))
      .then(items => {
        if (active) setKeys([...new Set(items.flatMap(({ content }) => [...content.matchAll(bibliographyPattern)]
          .filter(match => !/^(comment|string|preamble)$/i.test(match[1]) && !/[{}%#\\&]/.test(match[2]))
          .map(match => match[2])))].sort());
      })
      .catch(error => { if (active) setError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const change = event => {
    const { name, value, type, checked } = event.target;
    setForm(previous => ({ ...previous, [name]: type === 'checkbox' ? checked : value }));
    setError('');
  };
  const setGrid = (nextCells, nextAlign) => { setCells(nextCells); setAlign(nextAlign); setError(''); };
  const disabled = importing || (kind === 'figure' ? !form.image || uploading : kind === 'cite' ? !form.key : false);
  async function chooseLocalImage(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || uploading) return;
    if (!validImage(file.name)) { setError(t('invalidFigureFile')); return; }
    setError('');
    setUploading(true);
    try {
      const image = await uploadImage(file);
      setForm(previous => ({ ...previous, image }));
    } catch (error) {
      setError(error.code === 'CONFLICT' ? t('figureExists') : error.message);
    } finally { setUploading(false); }
  }
  function submit(event) {
    event.preventDefault();
    if (disabled) return;
    const label = form.label.trim();
    if (!validLabel(label)) { setError(t('invalidFormatLabel')); return; }
    if (label && !form.caption.trim()) { setError(t('labelNeedsCaption')); return; }
    if (kind === 'table' && (!cells[0].some(cell => cell.trim()) || !cells.slice(1).some(row => row.some(cell => cell.trim())))) {
      setError(t('tableNeedsData'));
      return;
    }
    if (kind === 'figure' && (!Number.isInteger(Number(form.width)) || Number(form.width) < 5 || Number(form.width) > 100)) {
      setError(t('invalidFigureWidth'));
      return;
    }
    onInsert(kind, { ...form, cells, align, label });
  }
  const rich = kind === 'table' || kind === 'figure';
  function keepFocus(event) {
    if (event.key !== 'Tab' || !rich) return;
    const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
      .filter(control => !control.hidden && control.getClientRects().length);
    if (event.shiftKey ? event.target === controls[0] : event.target === controls.at(-1)) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  }
  return <Dialog title={t({ heading: 'shortHeading', figure: 'shortFigure', table: 'threeLineTable', cite: 'shortCite' }[kind])} onClose={onClose} busy={uploading || importing} className={rich ? 'thesis-rich-format' : ''}>
    <form className="thesis-format-form" onSubmit={submit} onKeyDown={keepFocus}>
      {kind === 'heading' && <label className="fo-field">{t('headingLevel')}<select autoFocus name="command" value={form.command} onChange={change}>
        <option value="section">{t('hSection')}</option><option value="subsection">{t('hSubsection')}</option>
        <option value="subsubsection">{t('hSubsubsection')}</option><option value="paragraph">{t('hParagraph')}</option>
      </select></label>}
      {kind === 'figure' && <>
        <div className="thesis-image-picker">
          <label className="fo-field">{t('chooseImage')}<select autoFocus name="image" value={form.image} onChange={change} disabled={uploading}><option value="">{t(images.length ? 'chooseImage' : 'noImages')}</option>{images.map(item => <option key={item.path}>{item.path}</option>)}</select></label>
          <button type="button" className="fo-btn" disabled={uploading} onClick={() => filePicker.current?.click()}>{t(uploading ? 'loading' : 'figureUpload')}</button>
          <input ref={filePicker} type="file" aria-label={t('figureUpload')} hidden accept=".png,.jpg,.jpeg,.pdf" onChange={chooseLocalImage} />
        </div>
        {form.image && <figure className="thesis-image-sample">
          {/\.pdf$/i.test(form.image) ? <span>{form.image.split('/').at(-1)}</span> : <img alt={form.image} src={imageUrl(form.image)} /> }
        </figure>}
        <div className="thesis-format-fields">
          <label className="fo-field">{t('figureWidth')}<input name="width" type="number" min="5" max="100" step="1" required value={form.width} onChange={change} /></label>
          <label className="fo-field">{t('figurePosition')}<select name="placement" value={form.placement} onChange={change}>
            {['htbp', '!h', 't', 'b', 'p'].map(value => <option key={value} value={value}>{t('figurePlace_' + value)}</option>)}
          </select></label>
        </div>
        {graphicx.at != null ? <label className="thesis-package-option"><input type="checkbox" name="addPackage" checked={form.addPackage} onChange={change} />{t('figureAddGraphicx')}</label>
          : graphicx.loaded === false && <p className="fo-dialog-copy">{t('figureCheckGraphicx')}</p>}
        {!images.length && <p className="fo-dialog-copy">{t('figureUploadHint')}</p>}
      </>}
      {kind === 'table' && <>
        <TableGrid t={t} cells={cells} align={align} setGrid={setGrid} setError={setError} importing={importing} setImporting={setImporting} />
        {booktabs?.loaded === false && booktabs.at == null && <p className="fo-dialog-copy">{t('tableBooktabsMain')}</p>}
      </>}
      {rich && <div className="thesis-format-fields">
        <label className="fo-field">{t(kind === 'figure' ? 'figureCaption' : 'tableCaption')}<input name="caption" value={form.caption} onChange={change} maxLength={300} /></label>
        <label className="fo-field">{t('formatLabel')}<input name="label" placeholder={kind === 'figure' ? 'fig:results' : 'tab:results'} value={form.label} onChange={change} maxLength={80} /></label>
      </div>}
      {kind === 'cite' && <label className="fo-field">{t('chooseCitation')}<select autoFocus name="key" disabled={loading} value={form.key} onChange={change}><option value="">{t(loading ? 'loading' : keys.length ? 'chooseCitation' : 'noCitations')}</option>{keys.map(key => <option key={key}>{key}</option>)}</select></label>}
      {error && <p className="fo-form-error" role="alert">{error}</p>}
      <footer><button type="button" className="fo-btn" disabled={uploading || importing} onClick={onClose}>{t('close')}</button><button type="submit" className="fo-btn is-primary" disabled={disabled}>{t('insertFormat')}</button></footer>
    </form>
  </Dialog>;
}
