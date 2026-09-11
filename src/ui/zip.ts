/**
 * Minimaler ZIP-Schreiber (Methode "stored", ohne Komprimierung).
 *
 * Damit lässt sich der komplette Skriptsatz als ein Download ausliefern, ohne
 * eine Bibliothek einzubinden. Die Unix-Rechte landen in den External
 * Attributes, sodass `unzip` auf dem Zielsystem die Skripte direkt ausführbar
 * anlegt.
 */

export interface ZipEntry {
  name: string;
  content: string;
  /** Unix-Dateirechte, z. B. 0o755. */
  mode: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS-Zeitstempel, wie ihn das ZIP-Format erwartet. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(
      new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]),
    );
  }

  toBlob(type: string): Blob {
    return new Blob(this.chunks as BlobPart[], { type });
  }
}

export function createZip(entries: ZipEntry[], now = new Date()): Blob {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const out = new ByteWriter();
  const central: Array<{ entry: ZipEntry; crc: number; size: number; offset: number }> = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);
    const offset = out.length;

    out.u32(0x04034b50);
    out.u16(20); // Version zum Entpacken
    out.u16(0x0800); // Dateinamen sind UTF-8
    out.u16(0); // stored
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(data.length);
    out.u32(data.length);
    out.u16(nameBytes.length);
    out.u16(0);
    out.push(nameBytes);
    out.push(data);

    central.push({ entry, crc, size: data.length, offset });
  }

  const centralStart = out.length;

  for (const { entry, crc, size, offset } of central) {
    const nameBytes = encoder.encode(entry.name);

    out.u32(0x02014b50);
    out.u16((3 << 8) | 20); // erzeugt unter Unix
    out.u16(20);
    out.u16(0x0800);
    out.u16(0);
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(size);
    out.u32(size);
    out.u16(nameBytes.length);
    out.u16(0);
    out.u16(0);
    out.u16(0);
    out.u16(0);
    // Obere 16 Bit: Unix-Modus inklusive Dateityp (0o100000 = reguläre Datei).
    out.u32(((0o100000 | entry.mode) << 16) >>> 0);
    out.u32(offset);
    out.push(nameBytes);
  }

  const centralSize = out.length - centralStart;

  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0);

  return out.toBlob('application/zip');
}
