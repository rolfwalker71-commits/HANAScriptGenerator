import { describe, expect, it } from 'vitest';

import { defaultConfig } from './defaults.js';
import { generateSchemaLister, schemaQueryCommand } from './files/listSchemas.js';
import { describeSchema, parseSchemaListing } from './schemaListing.js';

/**
 * hdbsql formatiert je nach Version und Aufrufparametern unterschiedlich:
 * mal mit Spaltenkopf, mal in Anführungszeichen, mal mit Zeilenzähler. Die
 * Auswertung darf sich daran nicht stören.
 */
const HDBSQL_OUTPUT = `
'##SCHEMA##' || S.SCHEMA_NAME || '##'
"##SCHEMA##FINANCE##412##2048.5##"
"##SCHEMA##SALES##1203##15360.0##"
"##SCHEMA##STAGING##7##0##"
3 rows selected (overall time 12.431 msec)
`;

describe('parseSchemaListing', () => {
  it('liest Name, Tabellenzahl und Größe aus der hdbsql-Ausgabe', () => {
    expect(parseSchemaListing(HDBSQL_OUTPUT)).toEqual([
      { name: 'FINANCE', tables: 412, sizeMb: 2048.5 },
      { name: 'SALES', tables: 1203, sizeMb: 15360 },
      { name: 'STAGING', tables: 7, sizeMb: 0 },
    ]);
  });

  it('ignoriert Kopfzeilen, Zeilenzähler und die Abfrage selbst', () => {
    const names = parseSchemaListing(HDBSQL_OUTPUT).map((entry) => entry.name);
    expect(names).not.toContain('SCHEMA_NAME');
    expect(names).toHaveLength(3);
  });

  it('kommt mit CRLF und fehlenden Zahlen zurecht', () => {
    const text = '"##SCHEMA##ARCHIV####??##"\r\n"##SCHEMA##LOGS##0####"\r\n';
    expect(parseSchemaListing(text)).toEqual([
      { name: 'ARCHIV', tables: null, sizeMb: null },
      { name: 'LOGS', tables: 0, sizeMb: null },
    ]);
  });

  it('verwirft Namen, die kein gültiges Schema sein können', () => {
    const text = '##SCHEMA##GUT##1##1##\n##SCHEMA##bö se"; DROP##1##1##\n';
    expect(parseSchemaListing(text).map((e) => e.name)).toEqual(['GUT']);
  });

  it('entfernt Duplikate und sortiert', () => {
    const text = '##SCHEMA##ZULETZT##1##1##\n##SCHEMA##ALPHA##1##1##\n##SCHEMA##ALPHA##9##9##\n';
    expect(parseSchemaListing(text).map((e) => e.name)).toEqual(['ALPHA', 'ZULETZT']);
  });

  it('liefert nichts zurück, wenn die Datei eine Fehlermeldung enthält', () => {
    expect(parseSchemaListing('* 10: authentication failed SQLSTATE: 28000')).toEqual([]);
  });
});

describe('schemaQueryCommand', () => {
  const config = { ...defaultConfig(), host: 'hdbprod', port: 30015, dbUser: 'SYSTEM' };

  it('ist eine einzige Zeile zum Einfügen in ein cmd-Fenster', () => {
    const command = schemaQueryCommand(config);
    expect(command).not.toContain('\n');
    expect(command.startsWith('hdbsql -n hdbprod:30015 -u SYSTEM "')).toBe(true);
    expect(command.endsWith('"')).toBe(true);
  });

  it('übergibt kein Passwort, damit hdbsql selbst verdeckt danach fragt', () => {
    expect(schemaQueryCommand(config)).not.toContain('-p ');
  });

  it('lässt das Prozentzeichen roh, anders als in der Batchdatei', () => {
    // Verdoppelt gehört es nur dorthin, wo cmd.exe die Datei zeilenweise liest.
    expect(schemaQueryCommand(config)).toContain("'\\_SYS%'");
    expect(generateSchemaLister(config).content).toContain("'\\_SYS%%'");
  });

  it('liefert eine Ausgabe, die der Parser wieder einlesen kann', () => {
    // Die Marke aus dem Befehl und die Marke im Parser müssen zusammenpassen.
    const marker = schemaQueryCommand(config).match(/'(##[A-Z]+##)'/)?.[1] ?? '';
    expect(parseSchemaListing(`${marker}TESTSCHEMA##3##12##`)).toEqual([
      { name: 'TESTSCHEMA', tables: 3, sizeMb: 12 },
    ]);
  });
});

describe('describeSchema', () => {
  it('rechnet große Schemas in GB um', () => {
    expect(describeSchema({ name: 'X', tables: 1203, sizeMb: 15360 })).toBe('1203 Tabellen · 15.0 GB');
    expect(describeSchema({ name: 'X', tables: 1, sizeMb: 250 })).toBe('1 Tabelle · 250 MB');
  });

  it('lässt weg, was die Datenbank nicht geliefert hat', () => {
    expect(describeSchema({ name: 'X', tables: null, sizeMb: null })).toBe('');
    expect(describeSchema({ name: 'X', tables: 4, sizeMb: 0 })).toBe('4 Tabellen');
  });
});
