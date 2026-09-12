/** Kundenspezifische Konfiguration eines HANA-Schema-Exports. */

export type Compression = 'gz' | 'zst' | 'none';

export interface ScheduleConfig {
  /** Stunde 0-23. */
  hour: number;
  /** Minute 0-59. */
  minute: number;
  /** Crontab-Feld für den Wochentag, z. B. `*` oder `1-5`. */
  dayOfWeek: string;
}

export interface MailConfig {
  enabled: boolean;
  recipient: string;
  /** true = Mail nur bei Fehlern, false = Mail nach jedem Lauf. */
  onlyOnError: boolean;
  /** Mail-Kommando auf dem Zielsystem, üblicherweise `mailx`. */
  command: string;
}

/**
 * Auslagerung der Tagesarchive auf eine Hetzner StorageBox.
 *
 * Uebertragen wird per rsync ueber SSH. Ein Cronlauf kann kein Passwort
 * eingeben, deshalb ist ein SSH-Schluessel Voraussetzung.
 */
export interface OffloadConfig {
  enabled: boolean;
  /** z. B. `u123456.your-storagebox.de`. */
  host: string;
  /** Benutzer der Box oder eines Unterkontos, z. B. `u123456` oder `u123456-sub1`. */
  user: string;
  /** SSH-Port der Box. Hetzner verwendet 23, nicht 22. */
  port: number;
  /** Zielverzeichnis auf der Box, relativ zu deren Heimatverzeichnis. */
  remotePath: string;
  /**
   * Privater Schluessel auf dem HANA-Server, den der Cronlauf benutzt.
   *
   * Schluessel und nicht Passwort, weil ein Cronlauf keines eintippen kann:
   * unbeaufsichtigte Passwortanmeldung hiesse, es im Klartext auf dem Server
   * abzulegen und zusaetzlich sshpass zu installieren.
   */
  keyPath: string;
  /**
   * true = das Exportskript laegert direkt nach dem Lauf aus. Dann traegt
   * der Cronjob zusaetzlich einen Nachholtermin ein, der liegengebliebene
   * Tage aufsammelt. false = die Auslagerung bekommt einen eigenen Termin.
   */
  runAfterExport: boolean;
  /** Stunde des eigenen Auslagerungstermins. */
  hour: number;
  /** Minute des eigenen Auslagerungstermins. */
  minute: number;
  /**
   * Aufbewahrung auf der Box in Tagen. 0 schaltet das Aufraeumen ab und
   * laesst alles liegen – der sichere Ausgangspunkt.
   */
  remoteRetentionDays: number;
}

export interface ExportConfig {
  /** Erscheint im Skriptkopf und in den Dateinamen der Ausgabe. */
  customer: string;
  /** SAP-SID des Tenants, z. B. `HDB`. */
  sid: string;
  /** Instanznummer zweistellig, z. B. `00`. */
  instance: string;
  host: string;
  port: number;
  dbUser: string;
  /** Linux-Benutzer, unter dem Userstore-Key und Cronjob liegen. */
  osUser: string;
  userstoreKey: string;
  hdbsqlPath: string;
  scriptPath: string;
  exportBase: string;
  schemas: string[];
  threads: number;
  retentionDays: number;
  compression: Compression;
  /** true = unkomprimiertes Exportverzeichnis zusätzlich behalten. */
  keepRawExport: boolean;
  /** Mindestens freier Speicher in GB vor dem Export; 0 schaltet die Prüfung ab. */
  minFreeGb: number;
  schedule: ScheduleConfig;
  mail: MailConfig;
  offload: OffloadConfig;
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  field: keyof ExportConfig | 'schedule' | 'mail' | 'offload';
  severity: IssueSeverity;
  message: string;
}

export interface GeneratedFile {
  /** Dateiname für Download und Anzeige. */
  name: string;
  /** Kurzbeschreibung für die Tab-Leiste der UI. */
  title: string;
  /** Ein Satz dazu, wann diese Datei ausgeführt wird. */
  purpose: string;
  /** Sprache für die Syntaxauszeichnung in der UI. */
  language: 'bash' | 'markdown' | 'batch';
  /** true = beim Entpacken Ausführungsrecht setzen. */
  executable: boolean;
  content: string;
}
