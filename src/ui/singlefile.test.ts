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

function check(box: HTMLInputElement): void {
  box.checked = !box.checked;
  box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

/** Wählt einen Ausgabe-Tab und liefert dessen Inhalt. */
function fileContentOf(tabTitle: string): string {
  const tab = Array.from(doc.querySelectorAll<HTMLButtonElement>('.tabs .tab')).find(
    (button) => button.textContent === tabTitle,
  );
  tab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return doc.getElementById('fileContent')?.textContent ?? '';
}

/** Schiebt eine schemas.txt in die Dateiauswahl, wie es der Benutzer täte. */
async function loadListing(text: string): Promise<void> {
  const input = doc.getElementById('inputSchemaListing') as HTMLInputElement;
  const file = new dom.window.File([text], 'schemas.txt', { type: 'text/plain' });

  // `files` ist normalerweise schreibgeschützt und lässt sich nur so setzen.
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

  // Der Handler liest die Datei asynchron.
  await new Promise((resolve) => setTimeout(resolve, 20));
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

  it('lässt keinen Logo-Platzhalter in der ausgelieferten Datei zurück', () => {
    const html = readFileSync(BUNDLE, 'utf8');

    // Ohne assets/logo.* verschwindet das Element ganz; mit Logo steht dort
    // ein data-URI. Der rohe Platzhalter wäre in beiden Fällen ein Fehler
    // und zeigte im Browser ein kaputtes Bild.
    expect(html).not.toContain('__BRAND_LOGO__');

    const brand = doc.querySelector('img.brand');
    if (brand !== null) {
      expect(brand.getAttribute('src')).toMatch(/^data:image\//);
    }
  });

  it('schaltet die kompakte Darstellung um und merkt sich die Wahl', () => {
    const button = doc.getElementById('btnDensity') as HTMLButtonElement;
    const root = doc.documentElement;

    expect(root.dataset['compact']).not.toBe('1');
    expect(button.textContent).toBe('Kompakt');

    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(root.dataset['compact']).toBe('1');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('Normal');

    // Das Merken läuft über localStorage. jsdom verweigert den Zugriff bei
    // einem file://-Dokument; die Oberfläche fängt das ab und arbeitet
    // weiter. Genau dieses Weiterarbeiten wird hier geprüft.
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(root.dataset['compact']).not.toBe('1');
    expect(button.textContent).toBe('Kompakt');
  });

  it('scrollt in den Bereichen statt auf der Seite', () => {
    // In einer engen RDP-Sitzung soll nichts ausserhalb des Fensters landen.
    // Das CSS ist im Bündel minifiziert, daher ohne Leerzeichen gesucht.
    const html = readFileSync(BUNDLE, 'utf8');

    expect(html).toMatch(/body\{[^}]*overflow:hidden/);
    expect(html).toMatch(/#configForm\{[^}]*overflow-y:auto/);

    // Unterhalb einer Mindestgröße wieder eine normal scrollende Seite,
    // sonst passt der Inhalt irgendwann nirgends mehr hin.
    expect(html).toMatch(/@media\(max-width:900px\),\(max-height:480px\)/);
    expect(html).toMatch(/body\{height:auto;display:block;overflow:auto\}/);
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
      '0 · Schemaliste',
      '0 · Übertragen',
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

  it('lädt eine schemas.txt und macht daraus eine Auswahlliste', async () => {
    const listing = [
      '"##SCHEMA##FINANCE##412##2048.5##"',
      '"##SCHEMA##SALES##1203##15360.0##"',
      '"##SCHEMA##STAGING##7##0##"',
      '3 rows selected (overall time 12.431 msec)',
    ].join('\r\n');

    await loadListing(listing);

    const rows = Array.from(doc.querySelectorAll('.picker__row'));
    expect(rows.map((row) => row.querySelector('.picker__name')?.textContent)).toEqual([
      'FINANCE',
      'SALES',
      'STAGING',
    ]);
    expect(rows[1]?.querySelector('.picker__meta')?.textContent).toBe('1203 Tabellen · 15.0 GB');

    // Der Hinweistext bestätigt, woher die Liste kommt.
    expect(doc.getElementById('discoverHint')?.textContent).toContain('3 Schemas');
  });

  it('übernimmt angehakte Schemas in die Eingabe und wieder heraus', () => {
    const textarea = doc.getElementById('schemas') as HTMLTextAreaElement;
    const boxOf = (name: string): HTMLInputElement =>
      Array.from(doc.querySelectorAll<HTMLElement>('.picker__row'))
        .find((row) => row.querySelector('.picker__name')?.textContent === name)
        ?.querySelector('input') as HTMLInputElement;

    // Vorher standen dort ALPHA und BETA von Hand.
    expect(boxOf('SALES').checked).toBe(false);

    check(boxOf('SALES'));
    expect(textarea.value.split('\n')).toContain('SALES');

    check(boxOf('FINANCE'));
    const script = fileContentOf('Hauptskript');
    expect(script).toContain('"SALES"');
    expect(script).toContain('"FINANCE"');

    // Abwählen entfernt das Schema wieder aus Eingabe und Skript.
    check(boxOf('SALES'));
    expect(textarea.value.split('\n')).not.toContain('SALES');
    expect(fileContentOf('Hauptskript')).not.toContain('"SALES"');
  });

  it('wertet auch eine eingefügte hdbsql-Ausgabe aus, ganz ohne Datei', () => {
    // Der Weg für den Fall, dass Windows die heruntergeladene .cmd sperrt.
    type('schemaPaste', '##SCHEMA##KASSE##42##128##\n##SCHEMA##LAGER##9##64##');

    const names = Array.from(doc.querySelectorAll('.picker__name')).map((n) => n.textContent);
    expect(names).toEqual(['KASSE', 'LAGER']);
  });

  it('bietet Helferskript und Befehl erst an, wenn die Verbindungsdaten stehen', () => {
    const download = doc.getElementById('btnDownloadLister') as HTMLButtonElement;
    const copy = doc.getElementById('btnCopyCommand') as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    expect(copy.disabled).toBe(false);

    type('host', '');
    expect(download.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
    expect(doc.getElementById('discoverHint')?.textContent).toContain('Schritt 1');

    type('host', 'p42prod');
    expect(download.disabled).toBe(false);
    expect(copy.disabled).toBe(false);
  });

  it('meldet fehlende Pflichtangaben statt stumm nichts zu erzeugen', () => {
    type('host', '');
    expect(doc.getElementById('issues')?.hidden).toBe(false);
    expect(doc.getElementById('issues')?.textContent).toContain('Hostname');
    expect((doc.getElementById('btnNext') as HTMLButtonElement).disabled).toBe(true);
  });
});
