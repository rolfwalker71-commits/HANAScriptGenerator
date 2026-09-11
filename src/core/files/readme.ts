import type { ExportConfig, GeneratedFile } from '../types.js';
import { archiveExtension, baseName, compressionLabel, customerSlug, dirName } from './common.js';
import { cronLine, scheduleDescription } from './installCron.js';

/** Kundenspezifische Anleitung: Reihenfolge, Kommandos, Betrieb, Fehlersuche. */
export function generateReadme(config: ExportConfig): GeneratedFile {
  const slug = customerSlug(config.customer, config.sid);
  const script = baseName(config.scriptPath);
  const scriptDir = dirName(config.scriptPath);
  const ext = archiveExtension(config.compression);
  const first = config.schemas[0] ?? 'SCHEMA';
  const time = `${String(config.schedule.hour).padStart(2, '0')}:${String(config.schedule.minute).padStart(2, '0')}`;

  const schemaTree = config.schemas
    .map(
      (schema) =>
        `├── ${schema}/\n│   ├── ${schema}_2026-01-14.${ext}\n│   ├── ${schema}_2026-01-15.${ext}\n│   └── ...`,
    )
    .join('\n');

  const content = `# SAP HANA Schema-Export – ${config.customer || config.sid}

Erzeugt durch HANAScriptGenerator.

Jedes Schema wird **einzeln exportiert und einzeln archiviert**. Es entsteht also
pro Schema und Tag genau ein Archiv, nicht ein gemeinsames Archiv über alle Schemas.

## Konfiguration

| Einstellung | Wert |
| --- | --- |
| Kunde | ${config.customer || '–'} |
| Tenant / SID | ${config.sid} (Instanz ${config.instance}) |
| Host | ${config.host} |
| SQL-Port | ${config.port} |
| DB-Benutzer | ${config.dbUser} |
| Linux-Benutzer | ${config.osUser} |
| hdbuserstore-Key | ${config.userstoreKey} |
| hdbsql | ${config.hdbsqlPath} |
| Exportpfad | ${config.exportBase} |
| Skriptpfad | ${config.scriptPath} |
| Schemas | ${config.schemas.join(', ')} |
| Threads | ${config.threads} |
| Archivformat | ${compressionLabel(config.compression)} (\`*.${ext}\`) |
| Rohexport behalten | ${config.keepRawExport ? 'ja' : 'nein, nur das Archiv bleibt'} |
| Aufbewahrung | ${config.retentionDays} Tage |
| Zeitplan | ${scheduleDescription(config)} |
| Mindestens frei | ${config.minFreeGb > 0 ? `${config.minFreeGb} GB` : 'keine Prüfung'} |
| Mailbenachrichtigung | ${
    config.mail.enabled
      ? `${config.mail.recipient} (${config.mail.onlyOnError ? 'nur bei Fehlern' : 'nach jedem Lauf'})`
      : 'nein'
  } |

## Dateien

| Datei | Zweck |
| --- | --- |
| \`00_schemas_auslesen.cmd\` | Läuft auf **Windows**, nicht auf dem Server: holt die Schemaliste für den Generator. Für den Export nicht nötig. |
| \`00_dateien_uebertragen.cmd\` | Läuft auf **Windows**: kopiert alles hierher per scp und setzt Rechte. |
| \`01_setup_userstore.sh\` | Legt den hdbuserstore-Key \`${config.userstoreKey}\` an. |
| \`02_prepare_dirs.sh\` | Erstellt Export- und Logverzeichnisse. |
| \`03_preflight.sh\` | Prüft alle Voraussetzungen, ändert nichts. |
| \`04_test_export.sh\` | Einmaliger Testexport inklusive tar-Lauf. |
| \`${script}\` | Das eigentliche Exportskript für den Cronlauf. |
| \`05_install_cron.sh\` | Trägt den Cronjob ein, aktualisiert oder entfernt ihn. |
| \`90_restore_schema.sh\` | Entpackt ein Archiv und spielt es per IMPORT zurück. |

## Einrichtung

Alle Schritte laufen als \`${config.osUser}\`. Der hdbuserstore ist benutzerspezifisch –
Key und Cronjob müssen deshalb unter demselben Benutzer liegen.

### 0. Dateien auf das System bringen

**Bequem:** auf dem Windows-Rechner \`00_dateien_uebertragen.cmd\` doppelklicken. Es
kopiert alle Skripte per \`scp\` nach \`${scriptDir}\`, räumt Windows-Zeilenenden weg
und setzt \`chmod 750\` sowie die Gruppe \`sapsys\`. Dafür genügt der OpenSSH-Client,
den Windows seit Version 1809 mitbringt. Danach weiter bei Schritt 1.

\`chown\` ist dabei weder enthalten noch nötig: per \`scp\` als \`${config.osUser}\`
übertragene Dateien gehören bereits \`${config.osUser}\`.

**Von Hand:** als \`root\`:

\`\`\`bash
su - ${config.osUser}
\`\`\`

Skripte in ein Arbeitsverzeichnis kopieren, zum Beispiel \`${scriptDir}\`, und
ausführbar machen:

\`\`\`bash
chmod 750 *.sh
\`\`\`

Wurden die Dateien über Windows übertragen, vorsichtshalber die Zeilenenden prüfen:

\`\`\`bash
file *.sh
\`\`\`

Steht dort \`with CRLF line terminators\`, einmal umstellen:

\`\`\`bash
sed -i 's/\\r$//' *.sh
\`\`\`

Prüfen, ob der hdbsql-Pfad stimmt:

\`\`\`bash
which hdbsql
\`\`\`

Erwartet wird \`${config.hdbsqlPath}\`. Weicht die Ausgabe ab, muss in allen
Skripten die Zeile \`HDBSQL="..."\` auf den tatsächlichen Pfad geändert werden.

### 1. Userstore-Key anlegen

\`\`\`bash
./01_setup_userstore.sh
\`\`\`

Das Passwort für \`${config.dbUser}\` wird interaktiv abgefragt und landet weder im
Skript noch in der Crontab.

### 2. Verzeichnisse anlegen

\`\`\`bash
./02_prepare_dirs.sh
\`\`\`

### 3. Vorabprüfung

\`\`\`bash
./03_preflight.sh
\`\`\`

Erst weitermachen, wenn dieser Lauf ohne Fehler durchgeht.

### 4. Testexport

\`\`\`bash
./04_test_export.sh ${first}
\`\`\`

Damit sind Export **und** tar-Lauf einmal bewiesen. Bei großen Schemas gibt der
Lauf zusätzlich ein Gefühl für die spätere Laufzeit.

Der Lauf endet von selbst und räumt die Testdaten weg. Sollen sie zum Ansehen
liegen bleiben:

\`\`\`bash
./04_test_export.sh ${first} --keep
\`\`\`

### 5. Hauptskript installieren

Wurde \`00_dateien_uebertragen.cmd\` benutzt, liegt \`${script}\` bereits unter
\`${config.scriptPath}\` und ist fertig eingerichtet — dann direkt zur Syntaxprüfung
weiter unten springen.

Sonst dorthin kopieren:

\`\`\`bash
cp ${script} ${config.scriptPath}
\`\`\`

Eigentümer und Rechte setzen:

\`\`\`bash
chown ${config.osUser}:sapsys ${config.scriptPath}
\`\`\`

\`\`\`bash
chmod 750 ${config.scriptPath}
\`\`\`

Kontrolle:

\`\`\`bash
ls -l ${config.scriptPath}
\`\`\`

Erwartet wird \`-rwxr-x--- ${config.osUser} sapsys\`.

**Warum das wichtig ist:** Cron startet das Skript als \`${config.osUser}\`. Wurde es als
\`root\` hierher kopiert, gehört es \`root:root\`, und bei \`750\` darf \`${config.osUser}\` es
weder lesen noch ausführen — der Cronjob schlägt dann jede Nacht still fehl. Das
Ausführungsrecht wird gebraucht, weil die Crontab das Skript direkt aufruft.

\`750\` statt \`755\`, weil im Skript zwar kein Passwort steht (dafür gibt es den
hdbuserstore), aber Pfade, Schemanamen und der Name des Userstore-Key. Die
Gruppe \`sapsys\` behält Leserecht, damit andere Administratoren nachsehen können.

Syntaxprüfung ohne Ausführung:

\`\`\`bash
bash -n ${config.scriptPath}
\`\`\`

Dann einmal vollständig manuell starten:

\`\`\`bash
${config.scriptPath}
\`\`\`

Ergebnis prüfen:

\`\`\`bash
echo $?
\`\`\`

Muss \`0\` sein.

### 6. Cronjob einrichten

\`\`\`bash
./05_install_cron.sh
\`\`\`

Das Skript sichert eine bestehende Crontab, entfernt einen früheren Eintrag zu
diesem Export und setzt:

\`\`\`
${cronLine(config)}
\`\`\`

Kontrolle:

\`\`\`bash
crontab -l
\`\`\`

Entfernen lässt sich der Eintrag jederzeit mit \`./05_install_cron.sh --remove\`.

## Was täglich passiert

Um ${time} Uhr (${scheduleDescription(config)}) läuft der Export. Pro Schema
nacheinander:

1. \`EXPORT "SCHEMA"."*" AS BINARY INTO '.../SCHEMA/JJJJ-MM-TT' WITH REPLACE THREADS ${config.threads}\`
2. \`tar\` über das Tagesverzeichnis nach \`SCHEMA_JJJJ-MM-TT.${ext}\`
3. Prüfen, ob sich das Archiv lesen lässt
4. ${config.keepRawExport ? 'Rohexport bleibt zusätzlich liegen' : 'Rohexport löschen, es bleibt nur das Archiv'}

Erst danach werden Archive und Logs älter als ${config.retentionDays} Tage entfernt.

Das Archiv wird zuerst als \`.tmp\` geschrieben und erst nach erfolgreicher
Prüfung umbenannt. Ein abgebrochener Lauf hinterlässt dadurch kein
unvollständiges Archiv im Aufbewahrungsbestand.

\`\`\`
${config.exportBase}/
${schemaTree}
└── logs/
    ├── schema_export_2026-01-15_${String(config.schedule.hour).padStart(2, '0')}-${String(config.schedule.minute).padStart(2, '0')}-01.log
    └── ...
\`\`\`

Durch \`WITH REPLACE\` kann das Skript am selben Tag mehrfach laufen; der Export
des Tages wird dann ersetzt. Ein \`flock\` verhindert, dass sich zwei Läufe
überschneiden.

## Betrieb

Letztes Log ansehen:

\`\`\`bash
tail -50 "$(ls -1t ${config.exportBase}/logs/schema_export_*.log | head -1)"
\`\`\`

Nach Fehlern suchen:

\`\`\`bash
grep -i "fehler\\|error" "$(ls -1t ${config.exportBase}/logs/schema_export_*.log | head -1)"
\`\`\`

Belegten Platz prüfen:

\`\`\`bash
du -sh ${config.exportBase}/*
\`\`\`

Vorhandene Archive auflisten:

\`\`\`bash
./90_restore_schema.sh --list
\`\`\`

## Weiteres Schema aufnehmen

Im Exportskript den Block \`SCHEMAS=(...)\` ergänzen:

\`\`\`bash
vi ${config.scriptPath}
\`\`\`

Danach die Syntax prüfen:

\`\`\`bash
bash -n ${config.scriptPath}
\`\`\`

An der Crontab ändert sich nichts. Alternativ das Schema im
HANAScriptGenerator ergänzen und die Skripte neu erzeugen.

## Wiederherstellung

\`\`\`bash
./90_restore_schema.sh ${first} 2026-01-15
\`\`\`

Entpackt das Archiv nach \`${config.exportBase}/_restore\`, ohne die Datenbank zu
berühren. Erst mit \`--import\` wird tatsächlich zurückgespielt:

\`\`\`bash
./90_restore_schema.sh ${first} 2026-01-15 --import
\`\`\`

Das überschreibt vorhandene Objekte des Schemas und verlangt deshalb eine
Bestätigung durch Eintippen des Schemanamens.

## Fehlersuche

| Symptom | Ursache | Abhilfe |
| --- | --- | --- |
| Cronjob läuft nie, manuell klappt es | Skript gehört \`root\`, nicht \`${config.osUser}\` | \`ls -l ${config.scriptPath}\`, dann \`chown ${config.osUser}:sapsys\` |
| \`Permission denied\` beim Aufruf | Ausführungsrecht fehlt | \`chmod 750 ${config.scriptPath}\` |
| \`bad interpreter: ^M\` oder \`: not found\` | Datei kam mit Windows-Zeilenenden an | \`sed -i 's/\\r$//' *.sh\` |
| \`hdbsql nicht gefunden\` | Anderer Clientpfad | \`which hdbsql\`, Wert für \`HDBSQL\` anpassen |
| Anmeldung schlägt fehl | Key gehört einem anderen Linux-Benutzer | \`01_setup_userstore.sh\` als \`${config.osUser}\` ausführen |
| Lauf funktioniert interaktiv, per Cron nicht | Cron startet ohne Anmeldeprofil | Das Skript lädt \`~/.sapenv.sh\`; prüfen, ob die Datei existiert |
| \`Ein Export laeuft bereits\` | Vorheriger Lauf dauert noch an | Log prüfen, Laufzeit oder Zeitplan anpassen |
| Export bricht mit Platzmangel ab | Zielverzeichnis zu klein | \`MIN_FREE_GB\` setzen, Aufbewahrung verkürzen |
| Archiv fehlt, Rohexport liegt noch da | tar oder Prüflauf fehlgeschlagen | Log ansehen; der Rohexport bleibt in diesem Fall absichtlich erhalten |
`;

  return {
    name: `README_${slug}.md`,
    title: 'Anleitung',
    purpose: 'Kundenspezifischer Ablauf von der Einrichtung bis zur Wiederherstellung.',
    language: 'markdown',
    executable: false,
    content,
  };
}
