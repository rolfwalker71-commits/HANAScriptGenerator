import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig } from './defaults.js';
import { generateAll } from './generate.js';
import type { ExportConfig } from './types.js';

/**
 * Führt das Auslagerungsskript wirklich aus – gegen Attrappen von rsync und
 * sftp, die eine StorageBox durch ein lokales Verzeichnis ersetzen. Damit sind
 * Zielpfade, Gegenzählung, Vermerke und --pending gemeinsam abgedeckt.
 */

/**
 * Übersetzt `user@host:/pfad` in einen Ort unter FAKE_REMOTE. So verhält sich
 * die Attrappe für das Skript wie eine echte Gegenstelle.
 */
const REMOTE_HELPER = `
remote_path() {
    printf '%s' "\${FAKE_REMOTE}/\${1#*:}"
}
`;

const fakeRsync = `#!/bin/bash
${REMOTE_HELPER}
# Letztes Argument ist das Ziel, vorletztes die Quelle.
for LAST; do :; done
DEST="\${LAST}"
SRC=""
PREV=""
for ARG in "$@"; do
    [ "\${ARG}" = "\${DEST}" ] && SRC="\${PREV}"
    PREV="\${ARG}"
done

TARGET="$(remote_path "\${DEST}")"
mkdir -p "\${TARGET}"

# Nur Archive, so wie die echten --include/--exclude es vorgeben.
# Schleife statt find -exec: das \\; ueberlebt die Maskierungsebenen nicht.
for FILE in "\${SRC}"*.tar.gz
do
    [ -f "\${FILE}" ] && cp "\${FILE}" "\${TARGET}/"
done
echo "fake rsync: \${SRC} -> \${TARGET}"
exit 0
`;

const fakeSftp = `#!/bin/bash
${REMOTE_HELPER}
# Das Ziel steht im letzten Argument, die Befehle kommen über stdin.
for LAST; do :; done
BASE="\${FAKE_REMOTE}"

while read -r CMD ARG REST
do
    case "\${CMD}" in
        pwd)   echo "Remote working directory: /home" ;;
        mkdir) mkdir -p "\${BASE}\${ARG}" 2>/dev/null ;;
        ls)    ls -1 "\${BASE}\${REST}" 2>/dev/null ;;
        rm)    rm -f \${BASE}\${ARG} 2>/dev/null ;;
        rmdir) rmdir "\${BASE}\${ARG}" 2>/dev/null ;;
        quit)  break ;;
    esac
done
exit 0
`;

let root: string;
let remote: string;
let binDir: string;
let config: ExportConfig;

/** Inhalt des zuletzt geschriebenen Auslagerungs-Logs, für Fehlermeldungen. */
function latestLog(): string {
  const dir = join(config.exportBase, 'logs');
  if (!existsSync(dir)) return '(kein Log)';
  const logs = readdirSync(dir).filter((n) => n.startsWith('offload_')).sort();
  const last = logs[logs.length - 1];
  return last === undefined ? '(kein Log)' : readFileSync(join(dir, last), 'utf8');
}

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('bash', [join(root, '06_offload_storagebox.sh'), ...args], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        FAKE_REMOTE: remote,
      },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}\n--- Log ---\n${latestLog()}`,
      status: failure.status ?? -1,
    };
  }
}

/** Datum vor `daysAgo` Tagen als JJJJ-MM-TT. */
function dayBefore(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

/** Legt einen Tagesordner mit fertigen Archiven an, wie ihn ein Lauf hinterlässt. */
function makeDay(day: string, schemas: string[]): void {
  const dir = join(config.exportBase, day);
  mkdirSync(dir, { recursive: true });
  for (const schema of schemas) {
    writeFileSync(join(dir, `${schema}_${day}.tar.gz`), `Archiv ${schema} ${day}`, 'utf8');
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hsg-offload-'));
  remote = join(root, 'box');
  binDir = join(root, 'bin');
  mkdirSync(remote, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  for (const [name, body] of [
    ['rsync', fakeRsync],
    ['sftp', fakeSftp],
  ] as const) {
    const path = join(binDir, name);
    writeFileSync(path, body, 'utf8');
    chmodSync(path, 0o755);
  }

  const keyPath = join(root, 'id_ed25519');
  writeFileSync(keyPath, 'kein echter Schluessel\n', 'utf8');
  chmodSync(keyPath, 0o600);

  const base = defaultConfig();
  config = {
    ...base,
    customer: 'Offload Test',
    sid: 'OFL',
    host: 'localhost',
    osUser: userInfo().username,
    hdbsqlPath: join(root, 'hdbsql'),
    exportBase: join(root, 'exports'),
    scriptPath: join(root, 'schema_export.sh'),
    schemas: ['ALPHA', 'BETA'],
    offload: {
      ...base.offload,
      enabled: true,
      host: 'box.example.invalid',
      user: 'backup-kunde',
      port: 23,
      remotePath: '/home/hana_exporte/kunde',
      keyPath,
      runAfterExport: true,
      remoteRetentionDays: 30,
    },
  };

  for (const file of generateAll(config)) {
    const path = join(root, file.name);
    writeFileSync(path, file.content, 'utf8');
    if (file.executable) chmodSync(path, 0o755);
  }

  mkdirSync(join(config.exportBase, 'logs'), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('generiertes Auslagerungsskript', () => {
  it('prüft die Verbindung, ohne etwas zu übertragen', () => {
    const { stdout, status } = run(['--check']);
    expect(status).toBe(0);
    expect(stdout).toContain('Verbindung steht');
    expect(stdout).toContain('es wird nichts uebertragen');

    // Nichts angelegt, nichts übertragen.
    expect(existsSync(join(remote, 'home'))).toBe(false);
  });

  it('legt einen mehrstufigen Zielpfad an', () => {
    // sftp kennt kein mkdir -p. Ohne eigenes Anlegen je Ebene scheitert
    // jeder Zielpfad, der tiefer als eine Ebene liegt.
    const day = dayBefore(0);
    makeDay(day, config.schemas);
    run([day]);

    expect(existsSync(join(remote, 'home/hana_exporte'))).toBe(true);
    expect(existsSync(join(remote, 'home/hana_exporte/kunde'))).toBe(true);
  });

  it('kopiert einen Tagesordner und lässt ihn lokal liegen', () => {
    const day = dayBefore(0);
    makeDay(day, config.schemas);

    const { stdout, status } = run([day]);
    expect(status, stdout).toBe(0);

    const expected = config.schemas.map((s) => `${s}_${day}.tar.gz`).sort();

    // Auf der Gegenstelle liegen beide Archive.
    expect(readdirSync(join(remote, 'home/hana_exporte/kunde', day)).sort()).toEqual(expected);

    // Kopiert, nicht verschoben: lokal ist alles unverändert da.
    expect(readdirSync(join(config.exportBase, day)).sort()).toEqual(expected);

    // Und es gibt einen Vermerk, außerhalb des Tagesordners.
    expect(existsSync(join(config.exportBase, '.offloaded', day))).toBe(true);
  });

  it('holt mit --pending nach, was liegengeblieben ist', () => {
    const [gestern, vorgestern] = [dayBefore(1), dayBefore(2)];
    makeDay(gestern, ['ALPHA']);
    makeDay(vorgestern, ['BETA']);

    const { stdout, status } = run(['--pending']);
    expect(status, stdout).toBe(0);

    expect(existsSync(join(remote, 'home/hana_exporte/kunde', gestern, `ALPHA_${gestern}.tar.gz`))).toBe(true);
    expect(existsSync(join(remote, 'home/hana_exporte/kunde', vorgestern, `BETA_${vorgestern}.tar.gz`))).toBe(true);

    // Der bereits vermerkte Tag wurde nicht erneut angefasst.
    expect(stdout).not.toContain(`${dayBefore(0)}: uebertrage`);

    // Ein zweiter Lauf findet nichts mehr.
    expect(run(['--pending']).stdout).toContain('Nichts offen');
  });

  it('entfernt auf der Box, was älter ist als die dortige Aufbewahrung', () => {
    // 90 Tage alt, die Box hält 30 – der Tag muss nach der Übertragung
    // dort wieder verschwinden, lokal aber liegen bleiben.
    const alt = dayBefore(90);
    makeDay(alt, ['ALPHA']);

    const { status, stdout } = run([alt]);
    expect(status, stdout).toBe(0);

    expect(stdout).toContain(`entferne ${alt}`);
    expect(existsSync(join(remote, 'home/hana_exporte/kunde', alt))).toBe(false);
    expect(existsSync(join(config.exportBase, alt))).toBe(true);
  });

  it('meldet einen Tagesordner ohne Archive als Fehler', () => {
    const leer = dayBefore(3);
    mkdirSync(join(config.exportBase, leer), { recursive: true });

    const { stdout, status } = run([leer]);
    expect(status).not.toBe(0);
    expect(stdout).toContain('kein einziges Archiv');

    // Ohne Übertragung darf auch kein Vermerk entstehen.
    expect(existsSync(join(config.exportBase, '.offloaded', leer))).toBe(false);
  });

  it('schreibt ein eigenes Log mit Zeitstempel', () => {
    const logs = readdirSync(join(config.exportBase, 'logs')).filter((n) => n.startsWith('offload_'));
    expect(logs.length).toBeGreaterThan(0);

    const content = readFileSync(join(config.exportBase, 'logs', logs[0] as string), 'utf8');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} - /m);
  });
});
