import type { ExportConfig, GeneratedFile } from '../types.js';
import { offloadCronLine, offloadScheduleDescription } from './installCron.js';
import {
  EXPORT_CONF_NAME,
  GENERATOR_VERSION,
  SCHEMA_FILE_NAME,
  archiveExtension,
  baseName,
  compressionLabel,
  customerSlug,
  dirName,
} from './common.js';
import { cronLine, scheduleDescription } from './installCron.js';
import { confSections } from './exportConf.js';

/** Kundenspezifische Anleitung: Reihenfolge, Kommandos, Betrieb, Fehlersuche. */
export function generateReadme(config: ExportConfig): GeneratedFile {
  const slug = customerSlug(config.customer, config.sid);
  const script = baseName(config.scriptPath);
  const scriptDir = dirName(config.scriptPath);
  const ext = archiveExtension(config.compression);
  const first = config.schemas[0] ?? 'SCHEMA';
  const confTable = confSections(config)
    .flatMap((section) => section.entries)
    .map(
      (entry) =>
        `| \`${entry.key}\` | ${entry.description} | ${entry.value === '' ? '–' : `\`${entry.value}\``} |`,
    )
    .join('\n');
  const time = `${String(config.schedule.hour).padStart(2, '0')}:${String(config.schedule.minute).padStart(2, '0')}`;

  const dayTree = config.schemas
    .map((schema, index) =>
      index === config.schemas.length - 1
        ? `│   └── ${schema}_2026-01-15.${ext}`
        : `│   ├── ${schema}_2026-01-15.${ext}`,
    )
    .join('\n');

  const content = `# SAP HANA Schema-Export – ${config.customer || config.sid}

Erzeugt durch HANAScriptGenerator, Stand ${GENERATOR_VERSION}.

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
| Schemas | ${config.schemas.join(', ')} (gepflegt in \`${SCHEMA_FILE_NAME}\`) |
| Einstellungen | gepflegt in \`${EXPORT_CONF_NAME}\`; die folgenden Werte sind der Stand beim Erzeugen |
| Threads | ${config.threads} |
| Archivformat | ${compressionLabel(config.compression)} (\`*.${ext}\`) |
| Rohexport behalten | ${config.keepRawExport ? 'ja' : 'nein, nur das Archiv bleibt'} |
| Aufbewahrung | ${config.retentionDays} Tage |
| Zeitplan | ${scheduleDescription(config)} |
| Mindestens frei | ${config.minFreeGb > 0 ? `${config.minFreeGb} GB` : 'keine Prüfung'} |
| Auslagerung | ${
    config.offload.enabled
      ? `${config.offload.user}@${config.offload.host}:${config.offload.remotePath}` +
        ` (${config.offload.remoteRetentionDays > 0 ? `${config.offload.remoteRetentionDays} Tage dort` : 'dort ohne Aufräumen'})`
      : 'nein'
  } |
| Mailbenachrichtigung | ${
    config.mail.enabled
      ? `${config.mail.recipient} (${config.mail.onlyOnError ? 'nur bei Fehlern oder Hinweisen' : 'nach jedem Lauf'})`
      : 'nein'
  } |

## Dateien

| Datei | Zweck |
| --- | --- |
| \`00_schemas_auslesen.cmd\` | Läuft auf **Windows**, nicht auf dem Server: holt die Schemaliste für den Generator. Für den Export nicht nötig. |
| \`00_dateien_uebertragen.cmd\` | Läuft auf **Windows**: kopiert alles hierher per scp und setzt Rechte. |
| \`${EXPORT_CONF_NAME}\` | Betriebswerte wie Aufbewahrung, Threads, Mail${config.offload.enabled ? ' und StorageBox' : ''}. Wird bei jedem Lauf gelesen. |
| \`${SCHEMA_FILE_NAME}\` | Die zu sichernden Schemas, eins pro Zeile. Wird bei jedem Lauf gelesen – Schemas hier ergänzen oder entfernen. |
| \`01_setup_userstore.sh\` | Legt den hdbuserstore-Key \`${config.userstoreKey}\` an. |
| \`02_prepare_dirs.sh\` | Erstellt Export- und Logverzeichnisse. |
| \`03_preflight.sh\` | Prüft alle Voraussetzungen, ändert nichts. |
| \`04_test_export.sh\` | Einmaliger Testexport inklusive tar-Lauf. |
| \`${script}\` | Das eigentliche Exportskript für den Cronlauf. |
| \`05_install_cron.sh\` | Trägt den Cronjob ein, aktualisiert oder entfernt ihn. |${
    config.offload.enabled
      ? '\n| `06_offload_storagebox.sh` | Kopiert den Tagesordner auf die StorageBox. |'
      : ''
  }
| \`90_restore_schema.sh\` | Entpackt ein Archiv und spielt es per IMPORT zurück. |

## Aufrufe und Schalter

Vollständig, in der Reihenfolge der Dateien. Unbekannte Angaben werden
abgewiesen, statt ersatzweise etwas anderes zu tun.

| Aufruf | Wirkung |
| --- | --- |
| \`00_schemas_auslesen.cmd\` | Holt die Schemaliste. Ohne Schalter, aber zwei Variablen: \`set USERSTORE_KEY=…\` nimmt den hdbuserstore statt der Passwortabfrage, \`set HANA_DB=…\` fragt einen anderen Tenant ab. |
| \`00_dateien_uebertragen.cmd\` | Überträgt alles in einem Durchgang, eine Passwortabfrage. |
| \`00_dateien_uebertragen.cmd --key\` | Richtet einmalig einen SSH-Schlüssel ein, danach ohne Passwort. |
| \`00_dateien_uebertragen.cmd --scp\` | Einzelschritte statt einem Durchgang, falls \`tar\` fehlt. |
| \`./01_setup_userstore.sh\` | Legt den Userstore-Key an. Ohne Schalter. |
| \`./02_prepare_dirs.sh\` | Legt die Verzeichnisse an. Ohne Schalter. |
| \`./03_preflight.sh\` | Prüft alle Voraussetzungen. Ohne Schalter, ändert nichts. |
| \`./04_test_export.sh\` | Testexport des ersten Schemas aus \`${SCHEMA_FILE_NAME}\`. |
| \`./04_test_export.sh SCHEMA\` | Testexport dieses Schemas. |
| \`./04_test_export.sh [SCHEMA] --keep\` | Testdaten liegen lassen statt sie zu entfernen. |
| \`${config.scriptPath}\` | Der eigentliche Export. Ohne Schalter – alles Weitere steht in \`${EXPORT_CONF_NAME}\`. |
| \`./05_install_cron.sh\` | Trägt die Cron-Einträge ein oder aktualisiert sie. |
| \`./05_install_cron.sh --show\` | Zeigt nur den geplanten Eintrag und die aktuelle Crontab. |
| \`./05_install_cron.sh --remove\` | Entfernt die Einträge wieder. |${
    config.offload.enabled
      ? `
| \`./06_offload_storagebox.sh\` | Überträgt den heutigen Tagesordner. |
| \`./06_offload_storagebox.sh JJJJ-MM-TT\` | Überträgt genau diesen Tag noch einmal. |
| \`./06_offload_storagebox.sh --pending\` | Holt alles nach, was noch keinen Vermerk hat. |
| \`./06_offload_storagebox.sh --check\` | Prüft nur die Anmeldung, überträgt nichts. |
| \`./06_offload_storagebox.sh --setup\` | Einmalige Einrichtung des Schlüssels. \`--setup-key\` und \`--install-key\` sind ältere Namen dafür. |`
      : ''
  }
| \`./90_restore_schema.sh --list\` | Listet die vorhandenen Archive. Ohne Angabe passiert dasselbe. |
| \`./90_restore_schema.sh SCHEMA JJJJ-MM-TT\` | Entpackt das Archiv. Die Datenbank bleibt unberührt. |
| \`./90_restore_schema.sh SCHEMA JJJJ-MM-TT --import\` | Spielt zusätzlich zurück. Überschreibt Objekte und verlangt vorher den Schemanamen. |

## Einrichtung

Alle Schritte laufen als \`${config.osUser}\`. Der hdbuserstore ist benutzerspezifisch –
Key und Cronjob müssen deshalb unter demselben Benutzer liegen.

### 0. Dateien auf das System bringen

**Bequem:** auf dem Windows-Rechner \`00_dateien_uebertragen.cmd\` doppelklicken. Es
kopiert alle Skripte per \`scp\` nach \`${scriptDir}\`, räumt Windows-Zeilenenden weg
und setzt \`chmod 750\` sowie die Gruppe \`sapsys\`. Dafür genügt der OpenSSH-Client,
den Windows seit Version 1809 mitbringt. Danach weiter bei Schritt 1.

Auf dem Server schon vorhandene \`${EXPORT_CONF_NAME}\` und \`${SCHEMA_FILE_NAME}\` bleiben dabei
unverändert: beide werden dort gepflegt und sollen beim erneuten Übertragen nicht
verloren gehen.

\`chown\` ist dabei weder enthalten noch nötig: per \`scp\` als \`${config.osUser}\`
übertragene Dateien gehören bereits \`${config.osUser}\`.

**Von Hand:** als \`root\`:

\`\`\`bash
su - ${config.osUser}
\`\`\`

Skripte, \`${EXPORT_CONF_NAME}\` und \`${SCHEMA_FILE_NAME}\` gemeinsam in ein Arbeitsverzeichnis
kopieren, zum Beispiel \`${scriptDir}\`, und die Skripte ausführbar machen. Die beiden
Dateien müssen neben den Skripten liegen, dort werden sie gesucht.

\`\`\`bash
chmod 750 *.sh
\`\`\`

Wurden die Dateien über Windows übertragen, vorsichtshalber die Zeilenenden prüfen:

\`\`\`bash
file *.sh
\`\`\`

Steht dort \`with CRLF line terminators\`, einmal umstellen:

\`\`\`bash
sed -i 's/\\r$//' *.sh ${EXPORT_CONF_NAME} ${SCHEMA_FILE_NAME}
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

${
  config.offload.enabled
    ? `### 5b. Schlüssel für die StorageBox

\`\`\`bash
./06_offload_storagebox.sh --setup
\`\`\`

Der eine Aufruf erledigt alles: Schlüsselpaar anlegen, auf der Box ablegen,
Anmeldung prüfen. Das Passwort der Box wird dabei zweimal gebraucht — einmal
zum Holen der vorhandenen Schlüssel, einmal zum Schreiben.

Vorhandene Schlüssel auf der Box bleiben erhalten, unserer kommt dazu. Bei einer
Box, die mehrere Kunden bedient, hätte ein Überschreiben sonst den Zugang aller
anderen gelöscht.

Angelegt wird dabei auch \`/home/.ssh\` — das fehlt auf einer neuen Box, und
weder der Robot noch \`ssh-copy-id\` legen es zuverlässig an.

Der Aufruf lässt sich gefahrlos wiederholen: steht die Anmeldung schon, meldet
er das und rührt nichts an.

Die Vorabprüfung aus Schritt 3 meldet einen fehlenden Schlüssel bewusst nur als
Hinweis – sie läuft ja vor diesem Schritt.

`
    : ''
}### 6. Cronjob einrichten

\`\`\`bash
./05_install_cron.sh
\`\`\`

Das Skript sichert eine bestehende Crontab, entfernt frühere Einträge zu diesem
Export und setzt:

\`\`\`
${cronLine(config)}${
    config.offload.enabled ? `
${offloadCronLine(config)}` : ''
  }
\`\`\`${
    config.offload.enabled
      ? `

Der zweite Eintrag läuft ${offloadScheduleDescription(config)}.${
          config.offload.runAfterExport
            ? ' Die eigentliche Auslagerung erledigt schon das Exportskript;\ndieser Termin sammelt nur auf, was liegengeblieben ist.'
            : ''
        }`
      : ''
  }

Kontrolle:

\`\`\`bash
crontab -l
\`\`\`

Entfernen lässt sich der Eintrag jederzeit mit \`./05_install_cron.sh --remove\`.

## Was täglich passiert

Um ${time} Uhr (${scheduleDescription(config)}) läuft der Export. Die Schemas liest
er dabei jedes Mal frisch aus \`${SCHEMA_FILE_NAME}\`. Pro Schema nacheinander:

1. \`EXPORT "SCHEMA"."*" AS BINARY INTO '.../JJJJ-MM-TT/SCHEMA' WITH REPLACE THREADS ${config.threads}\`
2. \`tar\` über den Schemaordner nach \`JJJJ-MM-TT/SCHEMA_JJJJ-MM-TT.${ext}\`
3. Prüfen, ob sich das Archiv lesen lässt
4. ${config.keepRawExport ? 'Rohexport bleibt zusätzlich liegen' : 'Rohexport löschen, es bleibt nur das Archiv'}

Alles eines Laufs liegt damit in **einem Tagesordner**. Erst danach fallen
Tagesordner und Logs älter als ${config.retentionDays} Tage weg – der Ordner als Ganzes
(\`RETENTION_DAYS\` in \`${EXPORT_CONF_NAME}\`).

Verglichen wird dabei der **Ordnername**, nicht die Änderungszeit: ein Zugriff
beim Auslagern würde den Zeitstempel verschieben und die Frist stillschweigend
verlängern.

Das Archiv wird zuerst als \`.tmp\` geschrieben und erst nach erfolgreicher
Prüfung umbenannt. Ein abgebrochener Lauf hinterlässt dadurch kein
unvollständiges Archiv im Aufbewahrungsbestand.

\`\`\`
${config.exportBase}/
├── 2026-01-14/
│   └── ...
├── 2026-01-15/
${dayTree}
├── .offloaded/          Vermerk, welcher Tag übertragen ist
└── logs/
    ├── schema_export_2026-01-15_${String(config.schedule.hour).padStart(2, '0')}-${String(config.schedule.minute).padStart(2, '0')}-01.log
    └── ...
\`\`\`

Durch \`WITH REPLACE\` kann das Skript am selben Tag mehrfach laufen; der Export
des Tages wird dann ersetzt. Ein \`flock\` verhindert, dass sich zwei Läufe
überschneiden.

${
  config.offload.enabled
    ? `## Auslagerung auf die StorageBox

Nach dem Export kopiert \`06_offload_storagebox.sh\` den Tagesordner per \`rsync\`
auf \`${config.offload.user}@${config.offload.host}:${config.offload.remotePath}\`.
**Kopiert, nicht verschoben** – lokal bleibt alles bis zum Ablauf der ${config.retentionDays} Tage.

Übertragen werden nur die Archive, keine Rohexporte. Auf der Box liegt dadurch
je Tag ein Ordner mit Dateien in einer Ebene.

### Einmalig: Schlüssel einrichten

\`\`\`bash
./06_offload_storagebox.sh --setup
\`\`\`

Legt ein Schlüsselpaar an und zeigt den **öffentlichen** Teil. Diesen im Hetzner
Robot beim Unterkonto \`${config.offload.user}\` hinterlegen, oder von hier aus:

\`\`\`bash
ssh-copy-id -s -p ${config.offload.port} -i ${config.offload.keyPath}.pub ${config.offload.user}@${config.offload.host}
\`\`\`

Das \`-s\` ist nötig: eine Storage Box hat keine normale Shell, der Schlüssel muss
über SFTP abgelegt werden. Danach prüfen:

\`\`\`bash
./06_offload_storagebox.sh --check
\`\`\`

**Pro Kunde ein eigener Schlüssel.** Der private Teil verlässt diesen Server nie.
Derselbe Schlüssel auf mehreren Kundensystemen wäre ein geteiltes Geheimnis: ein
kompromittiertes System öffnete damit die Backups aller anderen auf derselben Box.
Eine Box nimmt beliebig viele Schlüssel an, einen pro Zeile in \`authorized_keys\`.

### Weitere Aufrufe

\`\`\`bash
./06_offload_storagebox.sh --pending
\`\`\`

Holt nach, was liegengeblieben ist – etwa nach einer Nacht ohne Netz. Welche Tage
übertragen sind, steht in \`${config.exportBase}/.offloaded\`.

\`\`\`bash
./06_offload_storagebox.sh 2026-01-15
\`\`\`

Überträgt genau einen Tag noch einmal.

`
    : ''
}## Betrieb

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

## Einstellungen ändern

Betriebswerte stehen in \`${scriptDir}/${EXPORT_CONF_NAME}\`, nicht in den Skripten:

| Schlüssel | Bedeutung | Wert beim Erzeugen |
| --- | --- | --- |
${confTable}

\`\`\`bash
vi ${scriptDir}/${EXPORT_CONF_NAME}
\`\`\`

Danach prüfen:

\`\`\`bash
./03_preflight.sh
\`\`\`

Die Änderung gilt ab dem nächsten Lauf. Ein ungültiger Wert, etwa
\`RETENTION_DAYS=zwei\`, hält den Lauf mit einer klaren Meldung an, statt mit einem
falschen Wert weiterzuarbeiten.

Nicht in dieser Datei stehen SID, Benutzer, hdbuserstore-Key, Pfade, Komprimierung
und die Uhrzeit des Laufs. Sie hängen an der Einrichtung – die Uhrzeit steht in der
Crontab – und werden über den Generator geändert.

\`00_dateien_uebertragen.cmd\` überschreibt eine vorhandene \`${EXPORT_CONF_NAME}\` nicht.
Bringt ein neuerer Generator einen zusätzlichen Schlüssel mit, meldet
\`03_preflight.sh\` ihn als fehlend. Dann die Zeile aus der neu erzeugten
\`${EXPORT_CONF_NAME}\` übernehmen.

## Schemas aufnehmen oder entfernen

Welche Schemas gesichert werden, steht allein in \`${scriptDir}/${SCHEMA_FILE_NAME}\`,
ein Schema pro Zeile. Export, Vorabprüfung und Testexport lesen die Datei bei
jedem Lauf.

\`\`\`bash
vi ${scriptDir}/${SCHEMA_FILE_NAME}
\`\`\`

Leerzeilen und Zeilen mit \`#\` am Anfang werden übergangen. Ein Schema lässt sich
damit auch vorübergehend auskommentieren. Danach prüfen:

\`\`\`bash
./03_preflight.sh
\`\`\`

Die Änderung gilt ab dem nächsten Lauf. Skripte und Crontab bleiben unverändert.

Steht ein Schema in der Liste, das es in der Datenbank nicht mehr gibt, bricht der
Export **nicht** ab: es wird übersprungen, im Log als \`HINWEIS\` vermerkt, und der
Lauf endet trotzdem mit \`0\`.${
    config.mail.enabled
      ? ' Eine Mail mit dem Betreff „erfolgreich mit Hinweisen“ geht auch dann raus, wenn sonst nur bei Fehlern gemailt wird.'
      : ''
  } Erst wenn kein einziges Schema der Liste mehr existiert, gilt der Lauf als
fehlgeschlagen.

\`00_dateien_uebertragen.cmd\` überschreibt eine vorhandene Liste nicht. Soll sie
doch aus dem Generator übernommen werden, die Datei auf dem Server vorher löschen.

## Wiederherstellung

\`\`\`bash
./90_restore_schema.sh ${first} 2026-01-15
\`\`\`

Sucht das Archiv unter \`${config.exportBase}/2026-01-15/\` und entpackt es nach
\`${config.exportBase}/_restore\`, ohne die Datenbank zu berühren. Erst mit \`--import\` wird tatsächlich zurückgespielt:

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
| Alte Schemaordner unter dem Exportpfad | Ablage vor der Umstellung auf Tagesordner | \`03_preflight.sh\` listet sie; nach Sichtung entfernen |
| \`bad interpreter: ^M\` oder \`: not found\` | Datei kam mit Windows-Zeilenenden an | \`sed -i 's/\\r$//' *.sh\` |
| \`HINWEIS: Schema ... existiert in der Datenbank aber nicht\` | Schema gelöscht oder umbenannt | Zeile in \`${SCHEMA_FILE_NAME}\` entfernen oder mit \`#\` auskommentieren |
| \`Schemaliste fehlt oder ist nicht lesbar\` | \`${SCHEMA_FILE_NAME}\` liegt nicht neben dem Skript | Datei aus dem ZIP neben \`${script}\` legen |
| \`hdbsql nicht gefunden\` | Anderer Clientpfad | \`which hdbsql\`, Wert für \`HDBSQL\` anpassen |
| Anmeldung schlägt fehl | Key gehört einem anderen Linux-Benutzer | \`01_setup_userstore.sh\` als \`${config.osUser}\` ausführen |
| Lauf funktioniert interaktiv, per Cron nicht | Cron startet ohne Anmeldeprofil | Das Skript lädt \`~/.sapenv.sh\`; prüfen, ob die Datei existiert |
| \`Ein Export laeuft bereits\` | Vorheriger Lauf dauert noch an | Log prüfen, Laufzeit oder Zeitplan anpassen |
| Export bricht mit Platzmangel ab | Zielverzeichnis zu klein | In \`${EXPORT_CONF_NAME}\` \`MIN_FREE_GB\` setzen, \`RETENTION_DAYS\` verkürzen |
| \`Einstellungen fehlen oder sind nicht lesbar\` | \`${EXPORT_CONF_NAME}\` liegt nicht neben dem Skript | Datei aus dem ZIP neben \`${script}\` legen |
| \`${EXPORT_CONF_NAME}: ... fehlt\` | Neuerer Generator, ältere Datei auf dem Server | Zeile aus der neu erzeugten \`${EXPORT_CONF_NAME}\` übernehmen |
| \`... ist ungueltig, erwartet wird ...\` | Tippfehler in \`${EXPORT_CONF_NAME}\` | Wert korrigieren, dann \`./03_preflight.sh\` |
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
