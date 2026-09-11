/** Hilfsfunktionen zum sicheren Einbetten von Werten in generierte Shell-Skripte. */

/** Schemanamen, die ohne Quoting-Risiko in SQL und Shell verwendbar sind. */
export const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_#$]*$/;

/** SIDs sind dreistellig und alphanumerisch, beginnend mit einem Buchstaben. */
export const SID_PATTERN = /^[A-Za-z][A-Za-z0-9]{2}$/;

/** Linux-Benutzernamen. */
export const OS_USER_PATTERN = /^[a-z_][a-z0-9_-]*\$?$/;

/**
 * Setzt einen Wert in einfache Anführungszeichen, so dass die Shell ihn
 * unverändert übernimmt. Eingebettete Apostrophe werden korrekt beendet
 * und wieder geöffnet.
 */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Setzt einen Wert in doppelte Anführungszeichen für Zuweisungen in der
 * Konfigurationssektion. Zeichen mit Sonderbedeutung werden maskiert.
 */
export function shDoubleQuote(value: string): string {
  return `"${value.replace(/([\\"$`])/g, '\\$1')}"`;
}

/** Entfernt Zeilenumbrüche, damit ein Wert eine Kommentarzeile nicht sprengt. */
export function shCommentSafe(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/** Normalisiert einen Pfad: kein abschließender Slash, keine Doppel-Slashes. */
export function normalizePath(path: string): string {
  const collapsed = path.trim().replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/** Zerlegt eine Schema-Eingabe aus Textarea, Komma- oder Leerzeichenliste. */
export function parseSchemaList(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}
