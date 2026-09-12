import { describe, expect, it } from 'vitest';

import { createZip, type ZipEntry } from './zip.js';

/**
 * Liest das zentrale Verzeichnis eines Archivs – die Stelle, aus der auch der
 * Windows-Explorer seine Dateiliste nimmt. Ein Archiv, das hier unvollständig
 * ist, erscheint dort leer, während `unzip` und 7-Zip nichts merken.
 */
interface CentralEntry {
  name: string;
  size: number;
  crc: number;
  externalAttributes: number;
  localOffset: number;
}

function readCentralDirectory(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End of Central Directory von hinten suchen.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Kein End of Central Directory gefunden.');

  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);

  if (offset + size > bytes.length) {
    throw new Error('Das zentrale Verzeichnis liegt ausserhalb der Datei.');
  }

  const decoder = new TextDecoder();
  const entries: CentralEntry[] = [];
  let pos = offset;

  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error(`Eintrag ${i} hat keine gültige Signatur.`);
    }

    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);

    entries.push({
      crc: view.getUint32(pos + 16, true),
      size: view.getUint32(pos + 24, true),
      nameLength,
      name: decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength)),
      externalAttributes: view.getUint32(pos + 38, true),
      localOffset: view.getUint32(pos + 42, true),
    } as CentralEntry);

    pos += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function zipBytes(entries: ZipEntry[]): Promise<Uint8Array> {
  return new Uint8Array(await createZip(entries).arrayBuffer());
}

const SAMPLE: ZipEntry[] = [
  { name: 'export_MUSTER/README.md', content: '# Anleitung\n', mode: 0o640 },
  { name: 'export_MUSTER/schema_export.sh', content: '#!/bin/bash\necho hallo\n', mode: 0o750 },
];

describe('createZip', () => {
  it('legt für jeden Ordner einen eigenen Eintrag an', async () => {
    const entries = readCentralDirectory(await zipBytes(SAMPLE));

    // Ohne diesen Eintrag zeigt der Windows-Explorer einen leeren Ordner.
    expect(entries.map((e) => e.name)).toEqual([
      'export_MUSTER/',
      'export_MUSTER/README.md',
      'export_MUSTER/schema_export.sh',
    ]);
  });

  it('legt auch für verschachtelte Pfade jede Ebene an', async () => {
    const entries = await zipBytes([{ name: 'a/b/c/datei.txt', content: 'x', mode: 0o644 }]);
    expect(readCentralDirectory(entries).map((e) => e.name)).toEqual([
      'a/',
      'a/b/',
      'a/b/c/',
      'a/b/c/datei.txt',
    ]);
  });

  it('kennzeichnet Ordner und Dateien für Windows wie für Unix', async () => {
    const entries = readCentralDirectory(await zipBytes(SAMPLE));
    const [dir, readme, script] = entries;

    // Unteres Wort: DOS-Attribute. 0x10 Verzeichnis, 0x20 Archivbit.
    expect((dir?.externalAttributes ?? 0) & 0xffff).toBe(0x10);
    expect((readme?.externalAttributes ?? 0) & 0xffff).toBe(0x20);

    // Oberes Wort: Unix-Dateityp und Rechte, damit unzip das x-Bit setzt.
    expect((script?.externalAttributes ?? 0) >>> 16).toBe(0o100750);
    expect((readme?.externalAttributes ?? 0) >>> 16).toBe(0o100640);
    expect((dir?.externalAttributes ?? 0) >>> 16).toBe(0o040755);
  });

  it('zeigt auf gültige lokale Kopfsätze und nennt die richtige Größe', async () => {
    const bytes = await zipBytes(SAMPLE);
    const view = new DataView(bytes.buffer);

    for (const entry of readCentralDirectory(bytes)) {
      expect(view.getUint32(entry.localOffset, true), entry.name).toBe(0x04034b50);
    }

    const script = readCentralDirectory(bytes).find((e) => e.name.endsWith('.sh'));
    expect(script?.size).toBe(new TextEncoder().encode(SAMPLE[1]?.content ?? '').length);

    // Ordner sind leer, sonst stolpern strenge Entpacker.
    const dir = readCentralDirectory(bytes).find((e) => e.name.endsWith('/'));
    expect(dir?.size).toBe(0);
    expect(dir?.crc).toBe(0);
  });

  it('bleibt bei Umlauten im Dateinamen lesbar', async () => {
    const bytes = await zipBytes([{ name: 'ordner/größe.txt', content: 'ä', mode: 0o644 }]);
    expect(readCentralDirectory(bytes).map((e) => e.name)).toEqual(['ordner/', 'ordner/größe.txt']);
  });
});
