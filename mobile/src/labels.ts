/** Bay labels printed by the server: "CB1:LOC:<code>" (see countbone/ops/labels.py). */
const PREFIX = 'CB1:LOC:';

export function parseLabel(text: string): string | null {
  const t = text.trim();
  return t.toUpperCase().startsWith(PREFIX) ? t.slice(PREFIX.length).trim() || null : null;
}
