import { SCHEMA_MARKER } from './files/listSchemas.js';
import { SCHEMA_NAME_PATTERN } from './sh.js';

export interface DiscoveredSchema {
  name: string;
  /** Anzahl Tabellen, falls die Datenbank sie geliefert hat. */
  tables: number | null;
  /** Belegter Hauptspeicher in MB, falls ermittelbar. */
  sizeMb: number | null;
}

/**
 * Liest die von `00_schemas_auslesen.cmd` erzeugte Datei.
 *
 * Ausgewertet werden nur Zeilen mit der Marke; Spaltenköpfe, Trennlinien,
 * Zeilenzähler und sonstige Ausgabe von hdbsql werden dadurch ignoriert,
 * egal wie die jeweilige Clientversion formatiert.
 */
export function parseSchemaListing(text: string): DiscoveredSchema[] {
  const pattern = new RegExp(`${SCHEMA_MARKER}(.*?)##(.*?)##(.*?)##`);
  const seen = new Set<string>();
  const found: DiscoveredSchema[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match === null) continue;

    const name = (match[1] ?? '').trim();
    if (!SCHEMA_NAME_PATTERN.test(name) || seen.has(name)) continue;
    seen.add(name);

    found.push({
      name,
      tables: toNumber(match[2]),
      sizeMb: toNumber(match[3]),
    });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function toNumber(raw: string | undefined): number | null {
  const value = Number.parseFloat((raw ?? '').trim());
  return Number.isFinite(value) ? value : null;
}

/** Kurzbeschreibung eines Schemas für die Auswahlliste. */
export function describeSchema(schema: DiscoveredSchema): string {
  const parts: string[] = [];
  if (schema.tables !== null) {
    parts.push(`${schema.tables} ${schema.tables === 1 ? 'Tabelle' : 'Tabellen'}`);
  }
  if (schema.sizeMb !== null && schema.sizeMb > 0) {
    parts.push(
      schema.sizeMb >= 1024
        ? `${(schema.sizeMb / 1024).toFixed(1)} GB`
        : `${Math.round(schema.sizeMb)} MB`,
    );
  }
  return parts.join(' · ');
}
