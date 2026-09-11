# HANAScriptGenerator

Ein Wizard, der alles abfragt, was für einen SAP-HANA-Schema-Export gebraucht wird,
und daraus den **kompletten Satz Skripte** für genau einen Kunden erzeugt:
Einrichtung, Vorabprüfung, Testexport, Exportskript, Crontab-Einplanung und Restore.

Nichts ist fest verdrahtet – vorbelegt ist nur, was bei jeder SAP-Installation
gleich ist (Port `3<nn>15`, Benutzer `<sid>adm`, Pfade unter `/usr/sap/<SID>/HDB<nn>`).
Diese Vorschläge lassen sich überall überschreiben.

**Jedes Schema wird einzeln exportiert und einzeln als tar archiviert.** Pro Schema
und Tag entsteht genau ein Archiv, kein Sammelarchiv über alle Schemas.

## Starten

`HANAScriptGenerator.html` **doppelklicken**. Fertig.

Die Datei ist vollständig eigenständig: kein Node, kein npm, kein Webserver, kein
Internet. Sie läuft unter Windows, Linux und macOS in jedem aktuellen Browser und
lässt sich per USB-Stick oder Mail auf einen Kundenrechner bringen.

Am Ende des Wizards steht **Alle als ZIP** – das lädt den kompletten Satz Dateien.
Die Skripte werden mit LF-Zeilenenden geschrieben, damit sie auf dem Linux-Server
direkt laufen; die erzeugte Anleitung sagt, wie sich das notfalls prüfen lässt.

Kundenprofile lassen sich im Browser speichern oder als JSON sichern und beim
nächsten Mal wieder laden.

## Ausgegebene Dateien

| Datei | Zweck |
| --- | --- |
| `README_<KUNDE>.md` | Anleitung mit Konfigurationstabelle, Ablauf und Fehlersuche |
| `01_setup_userstore.sh` | Legt den hdbuserstore-Key an, Passwort wird interaktiv abgefragt |
| `02_prepare_dirs.sh` | Export- und Logverzeichnisse samt Schreibtest |
| `03_preflight.sh` | Prüft Client, Verbindung, Schemas, Werkzeuge, Platz – ändert nichts |
| `04_test_export.sh` | Einmaliger Testexport inklusive tar-Lauf |
| `schema_export.sh` | Das eigentliche Exportskript für Cron |
| `05_install_cron.sh` | Trägt den Cronjob idempotent ein, `--show` / `--remove` |
| `90_restore_schema.sh` | Entpackt ein Archiv, `--import` spielt es zurück |

## Was das Exportskript tut

Pro Schema nacheinander:

1. `EXPORT "SCHEMA"."*" AS BINARY INTO '.../SCHEMA/JJJJ-MM-TT' WITH REPLACE THREADS n`
2. `tar` über das Tagesverzeichnis nach `SCHEMA_JJJJ-MM-TT.tar.gz`
3. Archiv gegenlesen, erst dann von `.tmp` auf den endgültigen Namen umbenennen
4. Rohexport entfernen, sofern nicht ausdrücklich behalten

Erst danach werden Archive und Logs älter als die Aufbewahrungsfrist entfernt.

Betrieblich abgesichert ist der Lauf durch `flock` gegen Überschneidungen, eine
Prüfung des ausführenden Linux-Benutzers (der hdbuserstore ist benutzerspezifisch),
das Laden von `~/.sapenv.sh` für den Cron-Kontext, eine optionale Mindestprüfung
des freien Speicherplatzes und einen Exitcode, der fehlgeschlagene Schemas meldet.

## Weiterentwickeln

Nur nötig, wenn am Generator selbst etwas geändert wird.

```bash
npm install
```

```bash
npm run dev
```

Entwicklungsserver auf <http://localhost:5180> mit Hot Reload.

```bash
npm run build
```

Schreibt `HANAScriptGenerator.html` neu – diese Datei ist das Auslieferungsartefakt
und wird mitversioniert.

```bash
npm test
```

Baut die Datei und prüft drei Ebenen:

- **Generator** – erzeugt alle Skripte und prüft jedes mit `bash -n`
- **Trockenlauf** – führt `schema_export.sh` gegen ein `hdbsql`-Attrappe wirklich aus,
  inklusive tar-Lauf, Archivprüfung, Aufräumen und Exitcode
- **Auslieferung** – lädt `HANAScriptGenerator.html` in ein DOM, bedient den Wizard
  und prüft, ob am Ende die erwarteten Skripte herauskommen

Unter Windows brauchen die ersten beiden Git Bash oder WSL, weil sie echtes Bash
aufrufen. Zum Benutzen des Generators ist das nicht nötig.

### Aufbau

```
src/core/          Reine Generatorlogik, ohne DOM
  types.ts         Konfigurationsmodell
  defaults.ts      Vorschläge und Ableitung aus SID und Instanznummer
  validate.ts      Prüfung vor der Generierung
  sh.ts            Quoting und Zerlegen der Eingaben
  files/           Je ein Modul pro ausgegebener Datei
src/ui/            Wizard, ZIP-Ausgabe, Kundenprofile
vite.config.ts     Bündelt CSS und JS in die eine HTML-Datei
```

Neue Ausgabedatei: ein Modul unter `src/core/files/` anlegen, das ein
`GeneratedFile` zurückgibt, und in `src/core/generate.ts` eintragen. Die
Bash-Syntaxprüfung im Test erfasst sie danach automatisch.
