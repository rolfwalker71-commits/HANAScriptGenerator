import type { ExportConfig, GeneratedFile } from '../types.js';
import { shCommentSafe } from '../sh.js';
import { GENERATOR_VERSION } from './common.js';

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
    'rem Bewusst OHNE enabledelayedexpansion: beim Einlesen ueber eine',
    'rem for-Schleife wuerde die verzoegerte Erweiterung ein Passwort mit',
    'rem "!" oder "^" stillschweigend veraendern. Die Bloecke unten sind',
    'rem deshalb ueber Sprungmarken geloest statt ueber if/else.',
    'setlocal',
    '',
    'rem ============================================================',
    'rem  Schemaliste aus SAP HANA holen',
    'rem',
    `rem  Kunde : ${shCommentSafe(config.customer) || '-'}`,
    `rem  Ziel  : ${config.host}:${config.port} als ${config.dbUser}`,
    'rem',
    'rem  Laeuft auf Windows, dort wo der SAP HANA Client installiert ist.',
    'rem  Schreibt schemas.txt neben diese Datei. Die Datei anschliessend',
    'rem  im HANAScriptGenerator ueber "schemas.txt laden" oeffnen.',
    'rem',
    `rem  Erzeugt durch HANAScriptGenerator, Stand ${GENERATOR_VERSION}.`,
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
    'rem Bei einem Mandantensystem hier den Namen der Datenbank eintragen,',
    'rem zum Beispiel SYSTEMDB oder den Namen des Tenants. Leer lassen, wenn',
    'rem der Port direkt zur gewuenschten Datenbank gehoert.',
    'set "HANA_DB="',
    '',
    'rem Optional: Name eines hdbuserstore-Key auf DIESEM Windows-Rechner.',
    'rem Ist er gesetzt, wird nicht nach dem Passwort gefragt.',
    'set "USERSTORE_KEY="',
    '',
    'set "OUTFILE=%~dp0schemas.txt"',
    'set "PWFILE=%TEMP%\\hsg_pw_%RANDOM%.tmp"',
    '',
    'rem --- hdbsql suchen ------------------------------------------',
    '',
    'where "%HDBSQL%" >nul 2>&1',
    'if not errorlevel 1 goto :have_hdbsql',
    'if exist "%HDBSQL%" goto :have_hdbsql',
    '',
    'echo FEHLER: hdbsql wurde nicht gefunden: %HDBSQL%',
    'echo.',
    'echo Der SAP HANA Client muss auf diesem Rechner installiert sein.',
    'echo Ueblicher Pfad:',
    'echo   C:\\Program Files\\SAP\\hdbclient\\hdbsql.exe',
    'echo.',
    'echo Diesen Pfad oben im Skript bei HDBSQL eintragen.',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':have_hdbsql',
    '',
    'rem --- Abfrage vorbereiten ------------------------------------',
    '',
    // In einer Batchdatei steht ein literales Prozentzeichen als %%.
    `set "SQL=${SCHEMA_QUERY.replace(/%/g, '%%')}"`,
    '',
    'set "DBOPT="',
    'if defined HANA_DB set "DBOPT=-d %HANA_DB%"',
    '',
    'if defined USERSTORE_KEY goto :use_key',
    '',
    'rem --- Passwort verdeckt einlesen -----------------------------',
    'rem',
    'rem  Der Umweg ueber eine Datei und "set /p" ist Absicht. Ein Passwort',
    'rem  aus einer for-Schleife zu uebernehmen veraendert Zeichen wie "!".',
    '',
    'echo Passwort fuer %HANA_USER% auf %HANA_HOST%:%HANA_PORT%',
    'powershell -NoProfile -Command "$s = Read-Host -AsSecureString \'Passwort\'; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))" > "%PWFILE%"',
    '',
    'set "HANA_PW="',
    'set /p HANA_PW=<"%PWFILE%"',
    'del "%PWFILE%" >nul 2>&1',
    '',
    'if not defined HANA_PW goto :no_password',
    '',
    'echo Frage Schemas ab ...',
    '',
    'rem Hinweis: -p uebergibt das Passwort als Argument und macht es kurz',
    'rem in der Prozessliste sichtbar. Fuer diesen einmaligen Aufruf auf dem',
    'rem eigenen Rechner vertretbar. Die erzeugten Linux-Skripte machen das',
    'rem bewusst nicht, sondern nutzen den hdbuserstore.',
    '"%HDBSQL%" -n %HANA_HOST%:%HANA_PORT% %DBOPT% -u %HANA_USER% -p "%HANA_PW%" "%SQL%" > "%OUTFILE%" 2>&1',
    'set "RC=%errorlevel%"',
    'set "HANA_PW="',
    'goto :check',
    '',
    ':use_key',
    'echo Frage Schemas ab ueber hdbuserstore-Key %USERSTORE_KEY% ...',
    '"%HDBSQL%" -U "%USERSTORE_KEY%" "%SQL%" > "%OUTFILE%" 2>&1',
    'set "RC=%errorlevel%"',
    'goto :check',
    '',
    ':no_password',
    'echo FEHLER: Es wurde kein Passwort eingegeben.',
    'pause',
    'exit /b 1',
    '',
    ':check',
    '',
    'rem --- Ergebnis -----------------------------------------------',
    '',
    'if "%RC%"=="0" goto :have_answer',
    '',
    'echo.',
    'echo FEHLER: hdbsql meldete Rueckgabewert %RC%.',
    'echo Antwort der Datenbank:',
    'echo.',
    'type "%OUTFILE%"',
    'echo.',
    'echo Steht dort "authentication failed", dann pruefen:',
    'echo   - Passwort ohne Tippfehler? Zum Gegentest ohne dieses Skript:',
    'echo       hdbsql -n %HANA_HOST%:%HANA_PORT% -u %HANA_USER% "SELECT CURRENT_USER FROM DUMMY"',
    'echo     Dabei fragt hdbsql selbst nach dem Passwort.',
    'echo   - Richtige Datenbank? Bei einem Mandantensystem hat SYSTEM in',
    'echo     SYSTEMDB ein anderes Passwort als im Tenant. Dann oben',
    'echo     HANA_DB setzen oder den Port des Tenants verwenden.',
    'echo.',
    'pause',
    'exit /b %RC%',
    '',
    ':have_answer',
    '',
    `findstr /C:"${SCHEMA_MARKER}" "%OUTFILE%" >nul`,
    'if not errorlevel 1 goto :done',
    '',
    'echo.',
    'echo WARNUNG: In der Antwort steht kein einziges Schema.',
    'echo Inhalt von schemas.txt:',
    'echo.',
    'type "%OUTFILE%"',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':done',
    'echo.',
    'echo Gefundene Schemas:',
    'echo.',
    `for /f "tokens=2 delims=#" %%S in ('findstr /C:"${SCHEMA_MARKER}" "%OUTFILE%"') do echo   %%S`,
    'echo.',
    'echo Geschrieben: %OUTFILE%',
    'echo.',
    'echo Diese Datei jetzt im HANAScriptGenerator unter "Schemas"',
    'echo ueber "schemas.txt laden" oeffnen.',
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
