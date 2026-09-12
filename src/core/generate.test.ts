import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultConfig, defaultSqlPort, derivedDefaults } from './defaults.js';
import { generateAll } from './generate.js';
import { cronLine, offloadCronLine, scheduleDescription } from './files/installCron.js';
import { hasErrors, validateConfig } from './validate.js';
import { parseSchemaList } from './sh.js';
import { GENERATOR_VERSION } from './files/common.js';
import type { ExportConfig } from './types.js';


/**
 * Vollständig ausgefüllte Beispielkonfiguration. Die Vorbelegung des Wizards
 * ist bewusst leer, damit nichts fest verdrahtet ist – die Tests brauchen aber
 * konkrete Werte.
 */
function exampleConfig(): ExportConfig {
  const sid = 'HDB';
  const instance = '00';
  const { keyPath, ...top } = derivedDefaults(sid, instance);
  return {
    ...defaultConfig(),
    customer: 'Beispiel GmbH',
    sid,
    instance,
    host: 'hdbprod',
    schemas: ['SALES', 'FINANCE'],
    ...top,
    offload: { ...defaultConfig().offload, keyPath },
  };
}

/** Wie exampleConfig, aber mit eingeschalteter Auslagerung. */
function offloadConfig(): ExportConfig {
  const base = exampleConfig();
  return {
    ...base,
    offload: {
      ...base.offload,
      enabled: true,
      host: 'box.example.invalid',
      user: 'backup-kunde',
      port: 23,
      remotePath: '/home/hana-export',
      keyPath: '/usr/sap/HDB/HDB00/work/.ssh/id_ed25519',
      runAfterExport: true,
      remoteRetentionDays: 60,
    },
  };
}

const workDir = mkdtempSync(join(tmpdir(), 'hana-script-generator-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Lässt `bash -n` über jedes generierte Shell-Skript laufen. */
function checkBashSyntax(config: ExportConfig): void {
  for (const file of generateAll(config)) {
    if (file.language !== 'bash') continue;
    const path = join(workDir, `${Math.random().toString(36).slice(2)}_${file.name}`);
    writeFileSync(path, file.content, 'utf8');
    expect(() => execFileSync('bash', ['-n', path], { stdio: 'pipe' }), file.name).not.toThrow();
  }
}

describe('generateAll', () => {
  it('erzeugt den vollständigen Satz Einzelskripte', () => {
    const files = generateAll(exampleConfig());
    expect(files.map((f) => f.name)).toEqual([
      'README_BEISPIEL_GMBH.md',
      '00_schemas_auslesen.cmd',
      '00_dateien_uebertragen.cmd',
      '01_setup_userstore.sh',
      '02_prepare_dirs.sh',
      '03_preflight.sh',
      '04_test_export.sh',
      'schema_export.sh',
      '05_install_cron.sh',
      '90_restore_schema.sh',
    ]);
  });

  it('liefert syntaktisch gültiges Bash für die Standardkonfiguration', () => {
    checkBashSyntax(exampleConfig());
  });

  it('liefert syntaktisch gültiges Bash für zstd, Mail und Rohexport', () => {
    checkBashSyntax({
      ...exampleConfig(),
      compression: 'zst',
      keepRawExport: true,
      minFreeGb: 200,
      schemas: ['ONE_SCHEMA'],
      mail: { enabled: true, recipient: 'ops@example.com', onlyOnError: false, command: 'mailx' },
      schedule: { hour: 23, minute: 30, dayOfWeek: '1-5' },
    });
  });

  it('liefert syntaktisch gültiges Bash ohne Komprimierung', () => {
    checkBashSyntax({ ...exampleConfig(), compression: 'none' });
  });

  it('liefert syntaktisch gültiges Bash mit Auslagerung', () => {
    // Ohne diesen Fall bliebe das Auslagerungsskript ungeprüft: es entsteht
    // nur, wenn die Auslagerung eingeschaltet ist.
    checkBashSyntax(offloadConfig());
  });

  it('exportiert und archiviert jedes Schema einzeln', () => {
    const config = exampleConfig();
    const script = generateAll(config).find((f) => f.name === 'schema_export.sh');
    const content = script?.content ?? '';

    // Eine Schleife über alle Schemas, ein EXPORT pro Durchlauf.
    expect(content.match(/EXPORT \\"\$\{SCHEMA\}\\"/g)).toHaveLength(1);
    expect(content).toContain('for SCHEMA in "${SCHEMAS[@]}"');

    // Alles eines Tages liegt in einem Ordner, je Schema ein eigenes Archiv.
    expect(content).toContain('DAY_DIR="${EXPORT_BASE}/${DATE}"');
    expect(content).toContain('ARCHIVE="${DAY_DIR}/${SCHEMA}_${DATE}.${ARCHIVE_EXT}"');
    expect(content).toContain('WORK_DIR="${DAY_DIR}/${SCHEMA}"');

    for (const schema of config.schemas) {
      expect(content).toContain(`    "${schema}"`);
    }
  });

  it('schreibt das Archiv erst als .tmp und benennt es danach um', () => {
    const script = generateAll(exampleConfig()).find((f) => f.name === 'schema_export.sh');
    const content = script?.content ?? '';
    expect(content).toContain('"${ARCHIVE}.tmp"');
    expect(content).toContain('mv -f "${ARCHIVE}.tmp" "${ARCHIVE}"');
    expect(content.indexOf('tar -C')).toBeLessThan(content.indexOf('mv -f "${ARCHIVE}.tmp"'));
  });

  it('verwendet WITH REPLACE, damit ein zweiter Lauf am selben Tag funktioniert', () => {
    const script = generateAll(exampleConfig()).find((f) => f.name === 'schema_export.sh');
    expect(script?.content).toContain('WITH REPLACE THREADS ${THREADS}');
  });

  it('räumt ganze Tagesordner nach Namen auf, nicht nach Änderungszeit', () => {
    const content =
      generateAll({ ...exampleConfig(), retentionDays: 14 }).find(
        (f) => f.name === 'schema_export.sh',
      )?.content ?? '';

    // Ein Zugriff beim Auslagern würde die Änderungszeit verschieben und die
    // Frist stillschweigend verlängern. Der Ordnername tut das nie.
    expect(content).toContain('CUTOFF="$(date -d "${RETENTION_DAYS} days ago" +%Y-%m-%d');
    // [[ ]], weil < in [ ] eine Umleitung wäre und nicht verglichen würde.
    expect(content).toContain('[[ "${ENTRY_DATE}" < "${CUTOFF}" ]]');
    // Lookbehind, weil "[[ \"" die Zeichenfolge "[ \"" enthält.
    expect(content).not.toMatch(/(?<!\[)\[ "\$\{ENTRY_DATE\}"/);
    expect(content).toContain('rm -rf "${ENTRY}"');

    // Nur Tagesordner, damit logs und .offloaded unangetastet bleiben.
    expect(content).toContain('/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
  });

  it('übernimmt abweichende Pfade in alle Skripte', () => {
    const config: ExportConfig = {
      ...exampleConfig(),
      hdbsqlPath: '/usr/sap/hdbclient/hdbsql',
      exportBase: '/backup/hana/exports',
    };
    for (const file of generateAll(config)) {
      // Kein Skript darf den abgeleiteten Standardpfad zurückbehalten.
      expect(file.content, file.name).not.toContain('/usr/sap/HDB/HDB00/exe/hdbsql');
      expect(file.content, file.name).not.toContain('/usr/sap/HDB/HDB00/work/schema_exports');
      // Das Windows-Helferskript sucht hdbsql auf dem Rechner des Beraters,
      // der Linux-Pfad des Servers gehört dort nicht hinein.
      if (file.language === 'bash' && file.content.includes('HDBSQL=')) {
        expect(file.content, file.name).toContain('/usr/sap/hdbclient/hdbsql');
      }
    }
  });

  it('baut sftp-Befehle als Here-Dokument, nicht über maskierte Zeilenumbrüche', () => {
    // printf 'ls %s\\nquit\\n' hängt davon ab, dass das \\n mehrere
    // Maskierungsebenen übersteht. Wird daraus unterwegs ein echter
    // Zeilenumbruch, bleibt der Anführungsstrich offen und das ganze
    // Skript ist unbrauchbar – bash meldet dann nur "Dateiende erreicht".
    const script =
      generateAll(offloadConfig()).find((f) => f.name === '06_offload_storagebox.sh')?.content ?? '';

    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    // Gemeint ist nur: keine sftp-Befehlsfolge aus maskierten Umbrüchen.
    // printf an sich ist in Ordnung, solange es nicht in sftp mündet.
    expect(code).not.toMatch(/printf[^\n]*\|[^\n]*sftp/);
    expect(code).toContain('<<SFTP_BATCH');
    for (const helper of ['box_pwd', 'box_mkdir_path', 'box_list', 'box_remove_day', 'setup', 'install_key']) {
      expect(code, helper).toContain(`${helper}()`);
    }
  });

  it('erzeugt das Windows-Helferskript mit CRLF und den Verbindungsdaten', () => {
    const config = exampleConfig();
    const helper = generateAll(config).find((f) => f.name === '00_schemas_auslesen.cmd');

    expect(helper?.language).toBe('batch');
    // cmd.exe verschluckt sich an Batchdateien mit reinen LF-Zeilenenden.
    const lines = (helper?.content ?? '').split('\n').slice(0, -1);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((line) => line.endsWith('\r'))).toBe(true);

    expect(helper?.content).toContain(`set "HANA_HOST=${config.host}"`);
    expect(helper?.content).toContain(`set "HANA_PORT=${config.port}"`);
    expect(helper?.content).toContain(`set "HANA_USER=${config.dbUser}"`);
    // In einer Batchdatei steht ein literales Prozentzeichen als %%.
    expect(helper?.content).toContain("'\\_SYS%%'");
  });
});

describe('Beispielwerte der StorageBox', () => {
  it('weist die Beispieladresse aus der Anleitung zurück', () => {
    // u123456.your-storagebox.de löst wirklich auf und gehört jemand
    // anderem. Übernommen statt ersetzt, landet ein Anmeldeversuch dort.
    const base = offloadConfig();

    for (const box of [
      { ...base.offload, user: 'u123456-sub1' },
      { ...base.offload, host: 'u123456.your-storagebox.de' },
      { ...base.offload, user: 'uXXXXXX-sub1' },
    ]) {
      const issues = validateConfig({ ...base, offload: box });
      expect(hasErrors(issues), box.user + ' ' + box.host).toBe(true);
      expect(issues.some((i) => i.message.includes('Beispielwerte'))).toBe(true);
    }
  });

  it('lässt echte Zugangsdaten durch', () => {
    const config = offloadConfig();
    expect(validateConfig(config).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('Cron-Eintrag für die Auslagerung', () => {
  it('trägt neben dem Export auch die Auslagerung ein', () => {
    const config = offloadConfig();
    const script = generateAll(config).find((f) => f.name === '05_install_cron.sh')?.content ?? '';

    expect(script).toContain(`CRON_LINE="${cronLine(config)}"`);
    expect(script).toContain(`OFFLOAD_LINE="${offloadCronLine(config)}"`);

    // Beide Zeilen müssen beim erneuten Lauf weggefiltert werden, sonst
    // sammeln sich Duplikate in der Crontab.
    expect(script).toContain('grep -v -F -- "${OFFLOAD_MARKER}"');
    expect(script).toContain('grep -v -F -- "${OFFLOAD_SCRIPT}"');
  });

  it('holt nur nach, wenn das Exportskript schon auslagert', () => {
    const nach = offloadConfig();
    expect(offloadCronLine(nach)).toContain('--pending');

    const eigen = { ...nach, offload: { ...nach.offload, runAfterExport: false } };
    expect(offloadCronLine(eigen)).not.toContain('--pending');
    expect(offloadCronLine(eigen)).toContain('06_offload_storagebox.sh >/dev/null');
  });

  it('lässt die Crontab unverändert, wenn nicht ausgelagert wird', () => {
    const script =
      generateAll(exampleConfig()).find((f) => f.name === '05_install_cron.sh')?.content ?? '';
    expect(script).not.toContain('OFFLOAD_LINE');
    expect(script).not.toContain('06_offload_storagebox.sh');
  });
});

describe('Vorabprüfung und Reihenfolge', () => {
  it('wertet einen fehlenden StorageBox-Schlüssel nicht als Fehler', () => {
    // Sie läuft als Schritt 3, der Schlüssel entsteht in Schritt 5b. Als
    // Fehler gewertet könnte die Prüfung nie bestehen.
    const script =
      generateAll(offloadConfig()).find((f) => f.name === '03_preflight.sh')?.content ?? '';

    const zeile = script.split('\n').find((l) => l.includes('noch nicht angelegt')) ?? '';
    expect(zeile).toContain('note ');
    expect(zeile).not.toContain('fail ');
    expect(script).toContain('--setup');
  });
});

describe('Stand des Generators', () => {
  it('steht im Kopf jeder erzeugten Datei', () => {
    // Auf dem Server ist sonst nicht zu erkennen, ob ein Skript vom
    // aktuellen Generator stammt oder von einem älteren Stand.
    for (const file of generateAll(offloadConfig())) {
      expect(file.content, file.name).toContain(`Stand ${GENERATOR_VERSION}`);
    }
  });

  it('ist gesetzt und nicht der Ersatzwert', () => {
    expect(GENERATOR_VERSION).not.toBe('Stand unbekannt');
    expect(GENERATOR_VERSION).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });
});

describe('Warten auf Eingaben', () => {
  const scriptNamed = (name: string) =>
    generateAll(exampleConfig()).find((f) => f.name === name)?.content ?? '';

  it('lässt das Cron-Skript niemals auf eine Eingabe warten', () => {
    // Ein read im Hauptskript würde den nächtlichen Lauf stehen lassen,
    // bis das Lock irgendwann jeden weiteren Lauf verhindert.
    expect(scriptNamed('schema_export.sh')).not.toMatch(/^\s*read\b/m);
  });

  it('lässt auch den Testexport durchlaufen, statt am Ende zu fragen', () => {
    // "Wartet auf Eingabe" ist von "hängt" nicht zu unterscheiden.
    const content = scriptNamed('04_test_export.sh');
    expect(content).not.toMatch(/^\s*read\b/m);
    expect(content).toContain('--keep');
    expect(content).toContain('KEEP_TEST_DATA="no"');
  });

  it('fragt nur dort, wo eine Eingabe die Sache ist', () => {
    // Passwort und die Bestätigung vor dem Überschreiben von Produktivdaten
    // sind genau die Stellen, an denen eine Rückfrage hingehört.
    expect(scriptNamed('01_setup_userstore.sh')).toMatch(/^\s*read -rs HANA_PASSWORD/m);
    expect(scriptNamed('90_restore_schema.sh')).toMatch(/^\s*read -r CONFIRM/m);
  });
});

describe('Protokollierung', () => {
  const mainScript = () =>
    generateAll(exampleConfig()).find((f) => f.name === 'schema_export.sh')?.content ?? '';

  it('schreibt jede Zeile mit Zeitstempel in Datei und auf den Bildschirm', () => {
    const content = mainScript();
    expect(content).toContain(`date '+%Y-%m-%d %H:%M:%S'`);
    expect(content).toContain('tee -a "${LOG_FILE}"');
    expect(content).toContain('LOG_FILE="${LOG_DIR}/schema_export_${TIMESTAMP}.log"');
  });

  it('hängt auch die Ausgabe von hdbsql und tar ins Log', () => {
    const content = mainScript();
    expect(content).toContain('"${SQL}" >> "${LOG_FILE}" 2>&1');
    expect(content).toContain('"${DATE}" >> "${LOG_FILE}" 2>&1');
  });

  it('räumt alte Logs nach derselben Frist weg wie die Archive', () => {
    const content = mainScript();
    expect(content).toContain(`-type f -name 'schema_export_*.log'`);
    expect(content).toContain('-mtime +$((RETENTION_DAYS - 1))');
  });
});

describe('Übertragungsskript', () => {
  const deploy = (config = exampleConfig()) =>
    generateAll(config).find((f) => f.name === '00_dateien_uebertragen.cmd');

  it('überträgt genau die Dateien, die auf den Server gehören', () => {
    const files = generateAll(exampleConfig());
    const content = deploy()?.content ?? '';

    for (const file of files) {
      if (file.name.endsWith('.sh') || file.name.endsWith('.md')) {
        expect(content, file.name).toContain(file.name);
      }
    }

    // Die Windows-Helfer bleiben auf dem Windows-Rechner. Geprüft wird die
    // Übertragungsliste selbst; in der Aufrufhilfe darf der eigene Name stehen.
    const fileList = content.match(/^set "FILES=(.*)"$/m)?.[1] ?? '';
    expect(fileList).not.toBe('');
    expect(fileList).not.toContain('.cmd');
    expect(fileList.split(' ')).toContain('schema_export.sh');
  });

  it('verzichtet auf chown, weil das nur root darf', () => {
    // Per scp als <sid>adm übertragene Dateien gehören bereits <sid>adm;
    // ein chown würde hier nur mit "Operation not permitted" scheitern.
    const content = deploy()?.content ?? '';
    expect(content).not.toMatch(/^\s*(ssh|chown)[^\n]*chown /m);
    expect(content).toContain('chgrp %TARGET_GROUP% *.sh');
  });

  it('setzt Rechte und räumt Windows-Zeilenenden weg', () => {
    const content = deploy()?.content ?? '';
    expect(content).toContain('chmod 750 *.sh');
    expect(content).toContain("sed -i 's/\\r$//' *.sh");
  });

  it('zielt auf das Verzeichnis des Exportskripts', () => {
    const config = { ...exampleConfig(), scriptPath: '/opt/hana/tools/schema_export.sh' };
    const content = deploy(config)?.content ?? '';
    expect(content).toContain('set "TARGET_DIR=/opt/hana/tools"');
    expect(content).toContain(`set "SSH_USER=${config.osUser}"`);
    expect(content).toContain(`set "SSH_HOST=${config.host}"`);
  });

  it('kommt im Normalfall mit einer einzigen Verbindung aus', () => {
    // OpenSSH für Windows kann keine Verbindung wiederverwenden
    // (kein ControlMaster), deshalb geht alles durch eine tar-Pipe:
    // übertragen, entpacken und einrichten in einem Aufruf.
    const content = deploy()?.content ?? '';
    expect(content).toContain('tar -cf - %FILES% | ssh ');
    expect(content).toContain("tar -xf - &&");

    // Genau ein ssh-Aufruf auf dem Hauptweg, vor dem Rückfallweg.
    // Bis zur Marke selbst, nicht bis zum goto weiter oben.
    const mainPath = content.slice(0, content.indexOf('\r\n:use_scp\r\n'));
    const sshCalls = mainPath.match(/^[^\r\n]*\bssh -p %SSH_PORT%/gm) ?? [];
    expect(sshCalls).toHaveLength(1);
  });

  it('bietet den Rückfallweg und die Schlüsseleinrichtung an', () => {
    const content = deploy()?.content ?? '';
    expect(content).toContain('if /I "%~1"=="--scp" goto :use_scp');
    expect(content).toContain('if /I "%~1"=="--key" goto :setup_key');
    expect(content).toContain('ssh-keygen -t ed25519');
    // Nur der öffentliche Teil geht an den Server.
    expect(content).toContain('type "%SSH_KEY%.pub" | ssh');
    expect(content).not.toMatch(/type "%SSH_KEY%" \| ssh/);
  });

  it('hat für jeden Sprung eine Marke und CRLF-Zeilenenden', () => {
    const content = deploy()?.content ?? '';

    for (const label of [':no_openssh', ':missing', ':transfer_failed', ':setup_key', ':done']) {
      expect(content, label).toContain(`\r\n${label}\r\n`);
      expect(content, label).toContain(`goto ${label}`);
    }

    const lines = content.split('\n').slice(0, -1);
    expect(lines.every((line) => line.endsWith('\r'))).toBe(true);
  });
});

describe('cron', () => {
  it('baut die Crontab-Zeile aus dem Zeitplan', () => {
    const config = { ...exampleConfig(), schedule: { hour: 2, minute: 0, dayOfWeek: '*' } };
    expect(cronLine(config)).toBe(
      '0 2 * * * /usr/sap/HDB/HDB00/work/schema_export.sh >/dev/null 2>&1',
    );
    expect(scheduleDescription(config)).toBe('täglich um 02:00 Uhr');
  });

  it('beschreibt Werktagspläne verständlich', () => {
    const config = { ...exampleConfig(), schedule: { hour: 22, minute: 15, dayOfWeek: '1-5' } };
    expect(cronLine(config)).toContain('15 22 * * 1-5');
    expect(scheduleDescription(config)).toBe('montags bis freitags um 22:15 Uhr');
  });
});

describe('defaults', () => {
  it('leitet den SQL-Port aus der Instanznummer ab', () => {
    expect(defaultSqlPort('00')).toBe(30015);
    expect(defaultSqlPort('02')).toBe(30215);
    expect(defaultSqlPort('7')).toBe(30715);
  });

  it('belegt nichts Kundenspezifisches vor', () => {
    const config = defaultConfig();
    expect(config.customer).toBe('');
    expect(config.sid).toBe('');
    expect(config.host).toBe('');
    expect(config.osUser).toBe('');
    expect(config.schemas).toEqual([]);
    expect([config.hdbsqlPath, config.exportBase, config.scriptPath]).toEqual(['', '', '']);
  });

  it('schlägt Benutzer und Pfade erst vor, wenn die SID bekannt ist', () => {
    expect(derivedDefaults('', '00').osUser).toBe('');
    expect(derivedDefaults('', '00').exportBase).toBe('');
    expect(derivedDefaults('', '00').keyPath).toBe('');

    const derived = derivedDefaults('P42', '05');
    expect(derived.osUser).toBe('p42adm');
    expect(derived.port).toBe(30515);
    expect(derived.exportBase).toBe('/usr/sap/P42/HDB05/work/schema_exports');
    expect(derived.keyPath).toBe('/usr/sap/P42/HDB05/work/.ssh/id_ed25519');
  });
});

describe('parseSchemaList', () => {
  it('trennt bei Zeilenumbruch, Komma und Leerzeichen und entfernt Duplikate', () => {
    expect(parseSchemaList('A, B\nC  D;A')).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('validateConfig', () => {
  it('akzeptiert die Standardkonfiguration', () => {
    expect(validateConfig(exampleConfig()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('weist Schemanamen mit Sonderzeichen ab', () => {
    const issues = validateConfig({ ...exampleConfig(), schemas: [`X"; DROP`] });
    expect(hasErrors(issues)).toBe(true);
    expect(issues.some((i) => i.field === 'schemas')).toBe(true);
  });

  it('verhindert einen Exportpfad zu nah an der Wurzel', () => {
    expect(hasErrors(validateConfig({ ...exampleConfig(), exportBase: '/tmp' }))).toBe(true);
  });

  it('verlangt absolute Pfade', () => {
    expect(hasErrors(validateConfig({ ...exampleConfig(), hdbsqlPath: 'hdbsql' }))).toBe(true);
  });

  it('verlangt eine Empfängeradresse, wenn Mail aktiv ist', () => {
    const issues = validateConfig({
      ...exampleConfig(),
      mail: { enabled: true, recipient: '', onlyOnError: true, command: 'mailx' },
    });
    expect(hasErrors(issues)).toBe(true);
  });

  it('akzeptiert den aus der SID abgeleiteten Instanzbenutzer ohne Hinweis', () => {
    const config = { ...exampleConfig(), sid: 'ANG', osUser: 'angadm' };
    expect(validateConfig(config).some((i) => i.field === 'osUser')).toBe(false);
  });

  it('weist auf die Konvention hin, blockiert einen anderen Benutzer aber nicht', () => {
    const issues = validateConfig({ ...exampleConfig(), sid: 'ANG', osUser: 'hdbadm' });
    const hint = issues.find((i) => i.field === 'osUser');

    expect(hasErrors(issues)).toBe(false);
    expect(hint?.severity).toBe('warning');
    expect(hint?.message).toContain('angadm');
  });

  it('warnt bei sehr vielen Threads, blockiert aber nicht', () => {
    const issues = validateConfig({ ...exampleConfig(), threads: 32 });
    expect(hasErrors(issues)).toBe(false);
    expect(issues.some((i) => i.severity === 'warning' && i.field === 'threads')).toBe(true);
  });
});
