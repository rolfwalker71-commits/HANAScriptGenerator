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
}

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  field: keyof ExportConfig | 'schedule' | 'mail';
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
