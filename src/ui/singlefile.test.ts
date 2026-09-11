import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Prüft das ausgelieferte Artefakt: die eine HTML-Datei, die beim Kunden per
 * Doppelklick geöffnet wird. Der Test baut sie, lädt sie in ein DOM, bedient
 * den Wizard und schaut, ob am Ende wirklich Skripte herauskommen.
 */

const BUNDLE = new URL('../../HANAScriptGenerator.html', import.meta.url).pathname;

let dom: JSDOM;
let doc: Document;

function type(id: string, value: string): void {
  const input = doc.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

beforeAll(() => {
  if (!existsSync(BUNDLE)) {
    execFileSync('npx', ['vite', 'build'], { cwd: new URL('../..', import.meta.url).pathname });
  }

  dom = new JSDOM(readFileSync(BUNDLE, 'utf8'), {
    runScripts: 'dangerously',
    url: 'file:///C:/tools/HANAScriptGenerator.html',
  });
  doc = dom.window.document;
});

describe('ausgelieferte Einzeldatei', () => {
  it('enthält keine externen Referenzen', () => {
    const html = readFileSync(BUNDLE, 'utf8');
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).toContain('<style>');
  });

  it('startet und zeigt den ersten Schritt', () => {
    expect(doc.querySelectorAll('.steps__item')).toHaveLength(7);
    expect(doc.querySelector('.steps__item[aria-current="true"]')?.textContent).toContain('System');
    expect((doc.getElementById('btnDownloadAll') as HTMLButtonElement).disabled).toBe(true);
  });

  it('schlägt erst bei vollständiger SID vor, nicht schon beim ersten Buchstaben', () => {
    const exportBase = doc.getElementById('exportBase') as HTMLInputElement;

    // Buchstabe für Buchstabe tippen: unterwegs darf kein /usr/sap/N/… stehen.
    type('sid', 'N');
    expect(exportBase.value).toBe('');
    type('sid', 'ND');
    expect(exportBase.value).toBe('');

    type('sid', 'NDB');
    expect(exportBase.value).toBe('/usr/sap/NDB/HDB00/work/schema_exports');
    expect((doc.getElementById('osUser') as HTMLInputElement).value).toBe('ndbadm');
    expect((doc.getElementById('hdbsqlPath') as HTMLInputElement).value).toBe(
      '/usr/sap/NDB/HDB00/exe/hdbsql',
    );
    expect((doc.getElementById('port') as HTMLInputElement).value).toBe('30015');
  });

  it('zieht die Pfade nach, wenn die SID nachträglich korrigiert wird', () => {
    const exportBase = doc.getElementById('exportBase') as HTMLInputElement;

    // Zurück auf eine unvollständige SID, dann eine andere zu Ende tippen.
    type('sid', 'ND');
    type('sid', 'P42');
    expect(exportBase.value).toBe('/usr/sap/P42/HDB00/work/schema_exports');
    expect((doc.getElementById('osUser') as HTMLInputElement).value).toBe('p42adm');
  });

  it('leitet den Port aus der Instanznummer ab', () => {
    type('instance', '05');
    expect((doc.getElementById('port') as HTMLInputElement).value).toBe('30515');
    expect((doc.getElementById('hdbsqlPath') as HTMLInputElement).value).toBe(
      '/usr/sap/P42/HDB05/exe/hdbsql',
    );
    type('instance', '00');
  });

  it('lässt einen von Hand gesetzten Pfad in Ruhe', () => {
    const exportBase = doc.getElementById('exportBase') as HTMLInputElement;
    type('exportBase', '/backup/hana/exports');
    type('sid', 'XYZ');

    expect(exportBase.value).toBe('/backup/hana/exports');
    // Die unangetasteten Felder folgen der neuen SID weiterhin.
    expect((doc.getElementById('hdbsqlPath') as HTMLInputElement).value).toBe(
      '/usr/sap/XYZ/HDB00/exe/hdbsql',
    );

    type('sid', 'P42');
    type('exportBase', '/usr/sap/P42/HDB00/work/schema_exports');
  });

  it('erzeugt nach vollständiger Eingabe alle Dateien', () => {
    type('customer', 'Muster AG');
    type('host', 'p42prod');
    type('schemas', 'ALPHA\nBETA');

    const tabs = Array.from(doc.querySelectorAll('.tabs .tab')).map((tab) => tab.textContent);
    expect(tabs).toEqual([
      'Anleitung',
      '1 · Userstore',
      '2 · Verzeichnisse',
      '3 · Vorabprüfung',
      '4 · Testexport',
      'Hauptskript',
      '5 · Cronjob',
      '90 · Restore',
    ]);

    expect((doc.getElementById('btnDownloadAll') as HTMLButtonElement).disabled).toBe(false);

    const preview = doc.getElementById('fileContent')?.textContent ?? '';
    expect(preview).toContain('SAP HANA Schema-Export');
    expect(preview).toContain('Muster AG');
  });

  it('zeigt im Hauptskript die Werte dieses Kunden', () => {
    const tab = Array.from(doc.querySelectorAll<HTMLButtonElement>('.tabs .tab')).find(
      (button) => button.textContent === 'Hauptskript',
    );
    tab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    const script = doc.getElementById('fileContent')?.textContent ?? '';
    expect(doc.getElementById('fileName')?.textContent).toBe('schema_export.sh');
    expect(script).toContain('HDBSQL="/usr/sap/P42/HDB00/exe/hdbsql"');
    expect(script).toContain('"ALPHA"');
    expect(script).toContain('"BETA"');
    expect(script).toContain('WITH REPLACE THREADS ${THREADS}');
    // Zeilenenden bleiben LF, auch wenn die Datei unter Windows entsteht.
    expect(script).not.toContain('\r');
  });

  it('meldet fehlende Pflichtangaben statt stumm nichts zu erzeugen', () => {
    type('host', '');
    expect(doc.getElementById('issues')?.hidden).toBe(false);
    expect(doc.getElementById('issues')?.textContent).toContain('Hostname');
    expect((doc.getElementById('btnNext') as HTMLButtonElement).disabled).toBe(true);
  });
});
