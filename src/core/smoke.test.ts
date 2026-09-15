import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig } from './defaults.js';
import { generateAll } from './generate.js';
import type { ExportConfig } from './types.js';

/**
 * Führt das generierte Skript wirklich aus – gegen ein hdbsql-Attrappe, das
 * statt eines Exports ein paar Dateien anlegt. Damit sind Schleife, tar-Lauf,
 * Archivprüfung, Aufräumen und Exitcode gemeinsam abgedeckt.
 */

const fakeHdbsql = `#!/bin/bash
# Attrappe: beantwortet den Verbindungstest und die Frage nach einem Schema
# und legt bei EXPORT Dateien an. Die Abfrage ist immer das letzte Argument.
# Schemas in FAKE_MISSING_SCHEMAS gibt es in dieser Datenbank nicht.
SQL="\${@: -1}"

case "\${SQL}" in
    *CURRENT_USER*)
        echo "SYSTEM"
        ;;
    *SYS.SCHEMAS*)
        NAME="$(printf '%s' "\${SQL}" | sed -n "s/.*SCHEMA_NAME = '\\([^']*\\)'.*/\\1/p")"
        case " \${FAKE_MISSING_SCHEMAS:-} " in
            *" \${NAME} "*) echo 0 ;;
            *)              echo 1 ;;
        esac
        ;;
    EXPORT*)
        TARGET="$(printf '%s' "\${SQL}" | sed -n "s/.*INTO '\\([^']*\\)'.*/\\1/p")"
        SCHEMA="$(printf '%s' "\${SQL}" | sed -n 's/EXPORT "\\([^"]*\\)".*/\\1/p')"
        mkdir -p "\${TARGET}/index"
        printf 'export of %s\\n' "\${SCHEMA}" > "\${TARGET}/index/\${SCHEMA}.bin"
        echo "0 rows affected"
        ;;
    *)
        echo "unhandled: \${SQL}" >&2
        exit 1
        ;;
esac
`;

let root: string;
let config: ExportConfig;

function writeGenerated(): void {
  for (const file of generateAll(config)) {
    const path = join(root, file.name);
    writeFileSync(path, file.content, 'utf8');
    if (file.executable) chmodSync(path, 0o755);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hsg-smoke-'));
  mkdirSync(join(root, 'bin'));

  const hdbsqlPath = join(root, 'bin', 'hdbsql');
  writeFileSync(hdbsqlPath, fakeHdbsql, 'utf8');
  chmodSync(hdbsqlPath, 0o755);

  config = {
    ...defaultConfig(),
    customer: 'Smoke Test',
    sid: 'SMK',
    host: 'localhost',
    osUser: userInfo().username,
    hdbsqlPath,
    exportBase: join(root, 'hana', 'exports'),
    scriptPath: join(root, 'hana', 'schema_export.sh'),
    schemas: ['ALPHA', 'BETA'],
    retentionDays: 14,
  };

  writeGenerated();
  execFileSync('bash', [join(root, '02_prepare_dirs.sh')], { stdio: 'pipe' });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Attrappe für hdbuserstore. `withKey` steuert, ob der gesuchte Key
 * vorhanden ist. Im leeren Zustand endet das echte hdbuserstore ungleich
 * null, obwohl es fehlerfrei gelaufen ist – genau das wird hier nachgebaut.
 */
function fakeUserstore(withKey: boolean): string {
  return `#!/bin/bash
if [ "\${1:-}" = "list" ] && [ -n "\${2:-}" ]; then
    ${
      withKey
        ? `echo "KEY $2"; echo "  ENV : localhost:30015"; echo "  USER: SYSTEM"; exit 0`
        : `echo "NUMBER OF COMPLETE KEY: 0"; echo "Operation succeed."; exit 1`
    }
fi
echo "DATA FILE       : /usr/sap/SMK/home/.hdb/host/SSFS_HDB.DAT"
echo "ACTIVE RECORDS  : 1"
echo "NUMBER OF COMPLETE KEY: ${withKey ? 1 : 0}"
echo "Operation succeed."
exit ${withKey ? 0 : 1}
`;
}

/** Führt 01_setup_userstore.sh mit einer hdbuserstore-Attrappe aus. */
function runUserstoreSetup(withKey: boolean): { stdout: string; status: number } {
  const binDir = join(root, `ustore_${withKey ? 'mit' : 'ohne'}`);
  mkdirSync(binDir, { recursive: true });

  const fake = join(binDir, 'hdbuserstore');
  writeFileSync(fake, fakeUserstore(withKey), 'utf8');
  chmodSync(fake, 0o755);

  try {
    const stdout = execFileSync('bash', [join(root, '01_setup_userstore.sh')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      input: '',
      env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, status: failure.status ?? -1 };
  }
}

describe('generiertes Userstore-Skript', () => {
  it('läuft auch, wenn noch gar kein Key hinterlegt ist', () => {
    const { stdout } = runUserstoreSetup(false);

    // Der leere Store endet ungleich null – das ist kein Grund abzubrechen.
    expect(stdout).not.toContain('hdbuserstore wurde nicht gefunden');
    expect(stdout).not.toContain('konnte nicht ausgefuehrt werden');

    // Es muss bis zur Passwortabfrage kommen.
    expect(stdout).toContain('Passwort fuer');
  });

  it('erkennt einen bereits vorhandenen Key an der Ausgabe', () => {
    const { stdout } = runUserstoreSetup(true);
    expect(stdout).toContain('existiert bereits');
  });

  it('bricht ab, wenn hdbuserstore wirklich fehlt', () => {
    // Ohne Attrappe im PATH. Auf einem Rechner mit echtem HANA-Client wäre
    // die Voraussetzung des Tests nicht gegeben.
    const clientInstalled = (() => {
      try {
        execFileSync('command', ['-v', 'hdbuserstore'], { stdio: 'pipe', shell: true });
        return true;
      } catch {
        return false;
      }
    })();

    if (clientInstalled) return;

    try {
      execFileSync('bash', [join(root, '01_setup_userstore.sh')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
        input: '',
      });
      throw new Error('Das Skript hätte fehlschlagen müssen.');
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      expect(failure.status).toBe(1);
      expect(failure.stderr).toContain('hdbuserstore wurde nicht gefunden');
    }
  });
});

describe('generiertes Exportskript im Trockenlauf', () => {
  it('exportiert und archiviert jedes Schema getrennt', () => {
    const output = execFileSync('bash', [join(root, 'schema_export.sh')], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');

    const today = new Date().toISOString().slice(0, 10);
    const dayDir = join(config.exportBase, today);

    // Alles eines Laufs liegt in genau einem Tagesordner.
    expect(existsSync(dayDir), dayDir).toBe(true);

    for (const schema of config.schemas) {
      const archive = join(dayDir, `${schema}_${today}.tar.gz`);

      // Pro Schema ein eigenes Archiv, kein Sammelarchiv.
      expect(existsSync(archive), archive).toBe(true);

      // Der Rohexport ist nach der Archivierung verschwunden.
      expect(existsSync(join(dayDir, schema))).toBe(false);

      // Und das Archiv enthält den Export des jeweiligen Schemas.
      const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
      expect(listing).toContain(`${schema}/index/${schema}.bin`);
    }

    // Im Tagesordner nur die Archive, nichts Halbfertiges.
    expect(readdirSync(dayDir).sort()).toEqual(
      config.schemas.map((s) => `${s}_${today}.tar.gz`).sort(),
    );

    // Unter der Basis der Tagesordner und die Verwaltungsordner.
    const entries = readdirSync(config.exportBase).filter((name) => !name.startsWith('.'));
    expect(entries.sort()).toEqual([today, 'logs'].sort());
  });

  it('lässt sich am selben Tag erneut ausführen', () => {
    const output = execFileSync('bash', [join(root, 'schema_export.sh')], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');

    const today = new Date().toISOString().slice(0, 10);
    const archives = readdirSync(join(config.exportBase, today));
    expect(archives.sort()).toEqual([`ALPHA_${today}.tar.gz`, `BETA_${today}.tar.gz`]);
  });

  it('überlebt ein SAP-Profil, das selbst ein exit enthält', () => {
    // Ein Profil wird mit "." in die laufende Shell gelesen. Ohne Subshell
    // würde dieses exit den Lauf sofort und ohne jede Ausgabe beenden.
    const fakeHome = join(root, 'home_mit_exit');
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(
      join(fakeHome, '.sapenv.sh'),
      'PATH="/sap/bin:${PATH}"\nexport PATH\nexit 0\n',
      'utf8',
    );

    const output = execFileSync('bash', [join(root, 'schema_export.sh')], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });

    expect(output).toContain('lade SAP-Umgebung');
    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');
  });

  it('gibt sofort etwas aus, damit ein stiller Abbruch auffällt', () => {
    const script = generateAll(config).find((f) => f.name === 'schema_export.sh');
    const executable = (script?.content ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    // Vor dem Einlesen des Profils muss etwas auf dem Bildschirm stehen,
    // sonst ist ein Abbruch genau dort nicht von "nichts passiert" zu
    // unterscheiden.
    const firstEcho = executable.findIndex((line) => line.startsWith('echo '));
    const firstProfile = executable.findIndex((line) => line.includes('.sapenv.sh'));

    expect(firstEcho).toBeGreaterThan(-1);
    expect(firstProfile).toBeGreaterThan(-1);
    expect(firstEcho).toBeLessThan(firstProfile);
  });

  it('bricht einmal klar ab, wenn das Log-Verzeichnis nicht beschreibbar ist', () => {
    const readOnlyBase = join(root, 'readonly_exports');
    mkdirSync(join(readOnlyBase, 'logs'), { recursive: true });
    chmodSync(join(readOnlyBase, 'logs'), 0o500);

    const blocked = { ...config, exportBase: readOnlyBase };
    const path = join(root, 'readonly_export.sh');
    const script = generateAll(blocked).find((file) => file.name.endsWith('schema_export.sh'));
    writeFileSync(path, script?.content ?? '', 'utf8');
    chmodSync(path, 0o755);

    try {
      execFileSync('bash', [path], { stdio: 'pipe', encoding: 'utf8' });
      throw new Error('Das Skript hätte fehlschlagen müssen.');
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;

      expect(failure.status).toBe(1);
      expect(output).toContain('kann nicht geschrieben werden');
      expect(output).toContain('chown -R');

      // Genau eine Meldung, nicht eine pro Logzeile.
      expect(output.split('tee:').length - 1).toBe(0);
    } finally {
      chmodSync(join(readOnlyBase, 'logs'), 0o700);
    }
  });

  it('meldet einen Fehler, wenn hdbsql fehlt', () => {
    const broken = { ...config, hdbsqlPath: join(root, 'bin', 'gibtsnicht') };
    const path = join(root, 'broken_export.sh');
    const script = generateAll(broken).find((file) => file.name.endsWith('schema_export.sh'));
    writeFileSync(path, script?.content ?? '', 'utf8');
    chmodSync(path, 0o755);

    try {
      execFileSync('bash', [path], { stdio: 'pipe', encoding: 'utf8' });
      throw new Error('Das Skript hätte fehlschlagen müssen.');
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      expect(failure.status).toBe(1);
      expect(failure.stdout).toContain('hdbsql nicht gefunden');
    }
  });
});

describe('Schemaliste im Lauf', () => {
  const listPath = () => join(root, 'export_schemas.txt');
  let original = '';

  beforeAll(() => {
    original = readFileSync(listPath(), 'utf8');
  });

  afterEach(() => {
    writeFileSync(listPath(), original, 'utf8');
  });

  /** Startet ein Skript und liefert Exitcode und Ausgabe, auch im Fehlerfall. */
  function run(script: string, env: Record<string, string> = {}): { status: number; output: string } {
    try {
      const output = execFileSync('bash', [join(root, script)], {
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    }
  }

  it('übernimmt eine geänderte Liste ohne neu erzeugte Skripte', () => {
    // Wie unter Windows bearbeitet: CRLF, Kommentare, Einrückung, doppelt.
    writeFileSync(listPath(), '# nur noch BETA\r\n\r\n   BETA   # Vertrieb\r\nBETA\r\n# ALPHA\r\n');

    const { status, output } = run('schema_export.sh');

    expect(status).toBe(0);
    expect(output).toMatch(/Schemas: BETA$/m);
    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');
  });

  it('überspringt ein Schema, das es nicht mehr gibt, ohne abzubrechen', () => {
    const { status, output } = run('schema_export.sh', { FAKE_MISSING_SCHEMAS: 'ALPHA' });

    expect(status).toBe(0);
    expect(output).toContain(
      'HINWEIS: Schema ALPHA steht in der Schemaliste, existiert in der Datenbank aber nicht',
    );
    expect(output).toContain('Erfolgreich: BETA');
    expect(output).toContain('Uebersprungen, nicht in der Datenbank: ALPHA');
    expect(output).toContain('Schema-Export erfolgreich abgeschlossen, mit Hinweisen');

    // Der Hinweis steht auch im Log, nicht nur auf dem Bildschirm.
    const logFile = output.match(/Logdatei: (\S+)/)?.[1] ?? '';
    expect(readFileSync(logFile, 'utf8')).toContain('HINWEIS: Schema ALPHA');
  });

  it('meldet eine unbrauchbare Zeile als Hinweis und exportiert den Rest', () => {
    writeFileSync(listPath(), "ALPHA\nSALES'; DROP\n");

    const { status, output } = run('schema_export.sh');

    expect(status).toBe(0);
    expect(output).toContain('Zeile 2:');
    expect(output).toContain('kein gueltiger Schemaname');
    expect(output).toContain('Erfolgreich: ALPHA');
    expect(output).toContain('mit Hinweisen');
  });

  it('bricht klar ab, wenn die Schemaliste fehlt', () => {
    renameSync(listPath(), `${listPath()}.weg`);
    try {
      const { status, output } = run('schema_export.sh');
      expect(status).toBe(1);
      expect(output).toContain('Schemaliste fehlt oder ist nicht lesbar');
    } finally {
      renameSync(`${listPath()}.weg`, listPath());
    }
  });

  it('gilt als fehlgeschlagen, wenn kein Schema der Liste mehr existiert', () => {
    const { status, output } = run('schema_export.sh', { FAKE_MISSING_SCHEMAS: 'ALPHA BETA' });

    expect(status).toBe(1);
    expect(output).toContain('Keines der Schemas');
    expect(output).toContain('Schema-Export mit Fehlern abgeschlossen');
  });

  it('mailt Hinweise auch, wenn sonst nur bei Fehlern gemailt wird', () => {
    const mailer = join(root, 'bin', 'fake_mail');
    const subjectFile = join(root, 'mail_subject.txt');
    writeFileSync(mailer, `#!/bin/bash\nprintf '%s\\n' "$2" > "${subjectFile}"\ncat > /dev/null\n`);
    chmodSync(mailer, 0o755);

    const withMail: ExportConfig = {
      ...config,
      mail: { enabled: true, recipient: 'ops@example.invalid', onlyOnError: true, command: mailer },
    };
    const script = generateAll(withMail).find((file) => file.name === 'schema_export.sh');
    // Neben die Schemaliste, dort sucht das Skript sie.
    writeFileSync(join(root, 'mail_export.sh'), script?.content ?? '');

    const { status } = run('mail_export.sh', { FAKE_MISSING_SCHEMAS: 'ALPHA' });

    expect(status).toBe(0);
    expect(readFileSync(subjectFile, 'utf8')).toContain('Schema-Export erfolgreich mit Hinweisen');
  });

  it('nimmt im Testexport ohne Angabe das erste Schema der Liste', () => {
    const { status, output } = run('04_test_export.sh');

    expect(status).toBe(0);
    expect(output).toContain('nehme das erste');
    expect(output).toContain('Testexport von Schema ALPHA');
  });
});
