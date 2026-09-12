import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
 * Prüft die Einrichtung (`--setup`) gegen eine sftp-Attrappe, die sich wie
 * eine Storage Box verhält: Schlüsselanmeldung schlägt fehl, solange der
 * Schlüssel nicht in authorized_keys steht, mit Passwort geht es immer.
 *
 * Der wichtigste Fall ist dabei eine Box, auf der schon ein fremder
 * Schlüssel liegt. Wird der überschrieben, verliert ein anderer Kunde
 * seinen Zugang – und niemand merkt es, bis dessen Auslagerung ausfällt.
 */
const fakeSftp = `#!/bin/bash
BASE="\${FAKE_REMOTE}"
AK="\${BASE}/.ssh/authorized_keys"

# Mit BatchMode gibt es kein Passwort: dann zaehlt nur der Schluessel.
BATCH="no"
for ARG in "$@"; do
    [ "\${ARG}" = "BatchMode=yes" ] && BATCH="yes"
done

if [ "\${BATCH}" = "yes" ]; then
    KEY_BODY="$(awk '{print $2}' "\${FAKE_PUBKEY}")"
    if [ ! -f "\${AK}" ] || ! grep -qF "\${KEY_BODY}" "\${AK}"; then
        echo "Permission denied (publickey)." >&2
        exit 255
    fi
fi

while read -r CMD ARG REST
do
    case "\${CMD}" in
        pwd)   echo "Remote working directory: /home" ;;
        mkdir) mkdir -p "\${BASE}/\${ARG#/}" 2>/dev/null ;;
        chmod) : ;;
        get)   [ -f "\${BASE}/\${ARG#/}" ] && cp "\${BASE}/\${ARG#/}" "\${REST}" ;;
        put)   mkdir -p "$(dirname "\${BASE}/\${REST#/}")"; cp "\${ARG}" "\${BASE}/\${REST#/}" ;;
        ls)    ls -1 "\${BASE}/\${REST#/}" 2>/dev/null ;;
        quit)  break ;;
    esac
done
exit 0
`;

let root: string;
let remote: string;
let binDir: string;
let config: ExportConfig;

const FREMDER_SCHLUESSEL =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFREMDERSCHLUESSELxxxxxxxxxxxxxxxxxxxxxxx anderer-kunde';

function runSetup(): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('bash', [join(root, '06_offload_storagebox.sh'), '--setup'], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        FAKE_REMOTE: remote,
        FAKE_PUBKEY: `${config.offload.keyPath}.pub`,
      },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, status: failure.status ?? -1 };
  }
}

function remoteKeys(): string {
  const path = join(remote, '.ssh', 'authorized_keys');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hsg-setup-'));
  remote = join(root, 'box');
  binDir = join(root, 'bin');
  mkdirSync(remote, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const sftp = join(binDir, 'sftp');
  writeFileSync(sftp, fakeSftp, 'utf8');
  chmodSync(sftp, 0o755);

  const base = defaultConfig();
  config = {
    ...base,
    customer: 'Setup Test',
    sid: 'STP',
    host: 'localhost',
    osUser: userInfo().username,
    hdbsqlPath: join(root, 'hdbsql'),
    exportBase: join(root, 'exports'),
    scriptPath: join(root, 'schema_export.sh'),
    schemas: ['ALPHA'],
    offload: {
      ...base.offload,
      enabled: true,
      host: 'box.example.invalid',
      user: 'backup-kunde',
      port: 23,
      remotePath: '/home/hana',
      keyPath: join(root, 'keys', 'id_ed25519'),
      runAfterExport: true,
      remoteRetentionDays: 0,
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

describe('Einrichtung der StorageBox in einem Aufruf', () => {
  it('lässt einen fremden Schlüssel auf der Box unangetastet', () => {
    // Eine Box, die mehrere Kunden bedient: hier liegt schon jemand.
    mkdirSync(join(remote, '.ssh'), { recursive: true });
    writeFileSync(join(remote, '.ssh', 'authorized_keys'), `${FREMDER_SCHLUESSEL}\n`, 'utf8');

    const { stdout, status } = runSetup();
    expect(status, stdout).toBe(0);

    const keys = remoteKeys();
    expect(keys).toContain(FREMDER_SCHLUESSEL);
    expect(keys).toContain(readFileSync(`${config.offload.keyPath}.pub`, 'utf8').trim());
    expect(keys.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(2);
  });

  it('erzeugt Schlüssel, legt ihn ab und meldet den Erfolg', () => {
    const { stdout } = runSetup();
    expect(stdout).toContain('Fingerabdruck');
    expect(existsSync(config.offload.keyPath)).toBe(true);
    expect(existsSync(`${config.offload.keyPath}.pub`)).toBe(true);
  });

  it('rührt beim zweiten Aufruf nichts mehr an', () => {
    const vorher = remoteKeys();

    const { stdout, status } = runSetup();
    expect(status, stdout).toBe(0);
    expect(stdout).toContain('funktioniert bereits');

    expect(remoteKeys()).toBe(vorher);
  });

  it('legt den Schlüssel mit 600 an', () => {
    const mode = execFileSync('stat', ['-c', '%a', config.offload.keyPath], { encoding: 'utf8' });
    expect(mode.trim()).toBe('600');
  });
});
