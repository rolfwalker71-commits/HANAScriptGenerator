import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig } from './defaults.js';
import { generateAll } from './generate.js';
import type { ExportConfig } from './types.js';

/**
 * Führt das generierte Skript wirklich aus – gegen ein hdbsql-Attrappe, das
 * statt eines Exports ein paar Dateien anlegt. Damit sind Schleife, tar-Lauf,
 * Archivprüfung, Aufräumen und Exitcode gemeinsam abgedeckt.
 */

const fakeHdbsql = `#!/bin/bash
# Attrappe: beantwortet den Verbindungstest und legt bei EXPORT Dateien an.
SQL="\${3:-}"

case "\${SQL}" in
    *CURRENT_USER*)
        echo "SYSTEM"
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

    for (const schema of config.schemas) {
      const dir = join(config.exportBase, schema);
      const archive = join(dir, `${schema}_${today}.tar.gz`);

      // Pro Schema genau ein eigenes Archiv.
      expect(existsSync(archive), archive).toBe(true);

      // Der Rohexport ist nach der Archivierung verschwunden.
      expect(existsSync(join(dir, today))).toBe(false);

      // Es bleibt kein halb geschriebenes .tmp zurück.
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

      // Und das Archiv enthält den Export des jeweiligen Schemas.
      const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
      expect(listing).toContain(`${today}/index/${schema}.bin`);
    }

    // Kein gemeinsames Archiv über alle Schemas (.lock ausgenommen).
    const entries = readdirSync(config.exportBase).filter((name) => !name.startsWith('.'));
    expect(entries.sort()).toEqual(['ALPHA', 'BETA', 'logs']);
  });

  it('lässt sich am selben Tag erneut ausführen', () => {
    const output = execFileSync('bash', [join(root, 'schema_export.sh')], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    expect(output).toContain('Alle Schema-Exporte erfolgreich abgeschlossen');

    const today = new Date().toISOString().slice(0, 10);
    const archives = readdirSync(join(config.exportBase, 'ALPHA'));
    expect(archives).toEqual([`ALPHA_${today}.tar.gz`]);
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
