import type { ExportConfig, GeneratedFile } from '../types.js';
import { shCommentSafe } from '../sh.js';

/** Zeilenmarke, an der die Auswertung die Schemazeilen wiedererkennt. */
export const SCHEMA_MARKER = '##SCHEMA##';

/**
 * Die Abfrage baut ihre Ausgabezeilen selbst zusammen und umrahmt sie mit
 * einer Marke. Dadurch ist die Auswertung unabhängig davon, wie hdbsql
 * Spaltenköpfe, Trennzeichen und Zeilenzähler formatiert.
 *
 */
export const SCHEMA_QUERY = [
  `SELECT '${SCHEMA_MARKER}' || S.SCHEMA_NAME || '##'`,
  `|| IFNULL(TO_VARCHAR(T.CNT), '0') || '##'`,
  `|| IFNULL(TO_VARCHAR(ROUND(M.MB, 1)), '') || '##'`,
  `FROM SYS.SCHEMAS S`,
  `LEFT JOIN (SELECT SCHEMA_NAME, COUNT(*) AS CNT FROM SYS.TABLES GROUP BY SCHEMA_NAME) T`,
  `ON T.SCHEMA_NAME = S.SCHEMA_NAME`,
  `LEFT JOIN (SELECT SCHEMA_NAME, SUM(MEMORY_SIZE_IN_TOTAL)/1048576 AS MB FROM SYS.M_CS_TABLES GROUP BY SCHEMA_NAME) M`,
  `ON M.SCHEMA_NAME = S.SCHEMA_NAME`,
  `WHERE S.SCHEMA_NAME NOT LIKE '\\_SYS%' ESCAPE '\\'`,
  `AND S.SCHEMA_NAME NOT IN ('SYS', 'PUBLIC')`,
  `ORDER BY S.SCHEMA_NAME;`,
].join(' ');

/**
 * Dieselbe Abfrage als eine Zeile zum Einfügen in ein offenes cmd-Fenster.
 *
 * Damit braucht es gar keine Datei. Windows versieht heruntergeladene Dateien
 * mit der Mark of the Web und verweigert bei `.cmd` die Ausführung, bis sie
 * von Hand freigegeben wird. Ein eingefügter Befehl umgeht das vollständig.
 *
 * Ohne `-p` fragt hdbsql das Passwort selbst ab und zeigt es nicht an.
 */
export function schemaQueryCommand(config: ExportConfig): string {
  return `hdbsql -n ${config.host}:${config.port} -u ${config.dbUser} "${SCHEMA_QUERY}"`;
}

/**
 * Windows-Batchdatei, die auf dem Rechner des Beraters läuft und die
 * Schemaliste aus der Datenbank holt.
 *
 * Ein Browser darf keine Programme starten – das ist die Sandbox-Grenze, die
 * verhindert, dass beliebige Webseiten Befehle absetzen. Deshalb übernimmt
 * dieses Skript den Aufruf von hdbsql, und der Wizard liest nur die Ausgabe.
 */
export function generateSchemaLister(config: ExportConfig): GeneratedFile {
  const lines = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    '',
    'rem ============================================================',
    'rem  Schemaliste aus SAP HANA holen',
    'rem',
    `rem  Kunde : ${shCommentSafe(config.customer) || '-'}`,
    `rem  Ziel  : ${config.host}:${config.port} als ${config.dbUser}`,
    'rem',
    'rem  Laeuft auf Windows, dort wo der SAP HANA Client installiert ist.',
    'rem  Schreibt schemas.txt neben diese Datei. Die Datei anschliessend',
    'rem  im HANAScriptGenerator ueber "Schemaliste laden" oeffnen.',
    'rem',
    'rem  Generiert durch HANAScriptGenerator.',
    'rem ============================================================',
    '',
    'rem --- Konfiguration ------------------------------------------',
    '',
    'rem Voller Pfad, falls hdbsql nicht im PATH liegt, zum Beispiel:',
    'rem set "HDBSQL=C:\\Program Files\\SAP\\hdbclient\\hdbsql.exe"',
    'set "HDBSQL=hdbsql"',
    '',
    `set "HANA_HOST=${config.host}"`,
    `set "HANA_PORT=${config.port}"`,
    `set "HANA_USER=${config.dbUser}"`,
    '',
    'rem Optional: Name eines hdbuserstore-Key auf DIESEM Windows-Rechner.',
    'rem Ist er gesetzt, wird nicht nach dem Passwort gefragt.',
    'set "USERSTORE_KEY="',
    '',
    'set "OUTFILE=%~dp0schemas.txt"',
    '',
    'rem --- hdbsql suchen ------------------------------------------',
    '',
    'where "%HDBSQL%" >nul 2>&1',
    'if errorlevel 1 (',
    '    if not exist "%HDBSQL%" (',
    '        echo FEHLER: hdbsql wurde nicht gefunden: %HDBSQL%',
    '        echo.',
    '        echo Der SAP HANA Client muss auf diesem Rechner installiert sein.',
    '        echo Ueblicher Pfad:',
    '        echo   C:\\Program Files\\SAP\\hdbclient\\hdbsql.exe',
    '        echo.',
    '        echo Diesen Pfad oben im Skript bei HDBSQL eintragen.',
    '        echo.',
    '        pause',
    '        exit /b 1',
    '    )',
    ')',
    '',
    'rem --- Abfrage ------------------------------------------------',
    '',
    // In einer Batchdatei steht ein literales Prozentzeichen als %%.
    `set "SQL=${SCHEMA_QUERY.replace(/%/g, '%%')}"`,
    '',
    'if defined USERSTORE_KEY (',
    '',
    '    echo Frage Schemas ab ueber hdbuserstore-Key !USERSTORE_KEY! ...',
    '    "%HDBSQL%" -U "!USERSTORE_KEY!" "!SQL!" > "%OUTFILE%" 2>&1',
    '    set "RC=!errorlevel!"',
    '',
    ') else (',
    '',
    '    echo Passwort fuer %HANA_USER% auf %HANA_HOST%:%HANA_PORT%',
    '',
    '    rem Eingabe verdeckt einlesen. "powershell -Command" ist keine',
    '    rem Skriptdatei und unterliegt daher keiner Ausfuehrungsrichtlinie.',
    '    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$s = Read-Host -AsSecureString \'Passwort\'; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "HANA_PW=%%P"',
    '',
    '    if not defined HANA_PW (',
    '        echo FEHLER: Es wurde kein Passwort eingegeben.',
    '        pause',
    '        exit /b 1',
    '    )',
    '',
    '    echo Frage Schemas ab ...',
    '',
    '    rem Hinweis: -p uebergibt das Passwort als Argument, es ist dadurch',
    '    rem kurz in der Prozessliste sichtbar. Fuer diesen einmaligen Aufruf',
    '    rem auf dem eigenen Rechner vertretbar. Die erzeugten Linux-Skripte',
    '    rem machen das bewusst nicht, sondern nutzen den hdbuserstore.',
    '    "%HDBSQL%" -n %HANA_HOST%:%HANA_PORT% -u %HANA_USER% -p "!HANA_PW!" "!SQL!" > "%OUTFILE%" 2>&1',
    '    set "RC=!errorlevel!"',
    '    set "HANA_PW="',
    '',
    ')',
    '',
    'rem --- Ergebnis -----------------------------------------------',
    '',
    'if not "!RC!"=="0" (',
    '    echo.',
    '    echo FEHLER: hdbsql meldete Rueckgabewert !RC!.',
    '    echo Antwort der Datenbank:',
    '    echo.',
    '    type "%OUTFILE%"',
    '    echo.',
    '    pause',
    '    exit /b !RC!',
    ')',
    '',
    `findstr /C:"${SCHEMA_MARKER}" "%OUTFILE%" >nul`,
    'if errorlevel 1 (',
    '    echo.',
    '    echo WARNUNG: In der Antwort steht kein einziges Schema.',
    '    echo Inhalt von schemas.txt:',
    '    echo.',
    '    type "%OUTFILE%"',
    '    echo.',
    '    pause',
    '    exit /b 1',
    ')',
    '',
    'echo.',
    'echo Gefundene Schemas:',
    'echo.',
    `for /f "tokens=2 delims=#" %%S in ('findstr /C:"${SCHEMA_MARKER}" "%OUTFILE%"') do echo   %%S`,
    'echo.',
    'echo Geschrieben: %OUTFILE%',
    'echo.',
    'echo Diese Datei jetzt im HANAScriptGenerator unter "Schemas"',
    'echo ueber "Schemaliste laden" oeffnen.',
    'echo.',
    'pause',
    '',
  ];

  return {
    name: '00_schemas_auslesen.cmd',
    title: '0 · Schemaliste',
    purpose:
      'Läuft auf dem Windows-Rechner, holt alle Schemas aus der Datenbank und schreibt schemas.txt für die Auswahl im Wizard.',
    language: 'batch',
    executable: false,
    // Batchdateien werden von cmd.exe zeilenweise gelesen; mit reinen
    // LF-Enden verschluckt sich der Interpreter an Sprungmarken und Bloecken.
    content: lines.join('\r\n'),
  };
}
