import './style.css';

import {
  archiveExtension,
  compressionLabel,
  cronLine,
  customerSlug,
  defaultConfig,
  derivedDefaults,
  generateAll,
  normalizeConfig,
  parseSchemaList,
  scheduleDescription,
  validateConfig,
  type ExportConfig,
  type GeneratedFile,
  type ValidationIssue,
} from '../core/index.js';
import { createZip } from './zip.js';

const PROFILE_STORAGE_KEY = 'hana-script-generator.profiles.v1';
const LAST_CONFIG_KEY = 'hana-script-generator.last.v1';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Element #${id} fehlt im Dokument.`);
  return node as T;
}

const fields = {
  customer: el<HTMLInputElement>('customer'),
  sid: el<HTMLInputElement>('sid'),
  instance: el<HTMLInputElement>('instance'),
  host: el<HTMLInputElement>('host'),
  port: el<HTMLInputElement>('port'),
  dbUser: el<HTMLInputElement>('dbUser'),
  osUser: el<HTMLInputElement>('osUser'),
  userstoreKey: el<HTMLInputElement>('userstoreKey'),
  hdbsqlPath: el<HTMLInputElement>('hdbsqlPath'),
  exportBase: el<HTMLInputElement>('exportBase'),
  scriptPath: el<HTMLInputElement>('scriptPath'),
  schemas: el<HTMLTextAreaElement>('schemas'),
  threads: el<HTMLInputElement>('threads'),
  compression: el<HTMLSelectElement>('compression'),
  minFreeGb: el<HTMLInputElement>('minFreeGb'),
  keepRawExport: el<HTMLInputElement>('keepRawExport'),
  retentionDays: el<HTMLInputElement>('retentionDays'),
  scheduleTime: el<HTMLInputElement>('scheduleTime'),
  scheduleDow: el<HTMLSelectElement>('scheduleDow'),
  scheduleDowCustom: el<HTMLInputElement>('scheduleDowCustom'),
  mailEnabled: el<HTMLInputElement>('mailEnabled'),
  mailRecipient: el<HTMLInputElement>('mailRecipient'),
  mailCommand: el<HTMLInputElement>('mailCommand'),
  mailOnlyOnError: el<HTMLInputElement>('mailOnlyOnError'),
};

const ui = {
  form: el<HTMLFormElement>('configForm'),
  stepNav: el<HTMLElement>('stepNav'),
  btnBack: el<HTMLButtonElement>('btnBack'),
  btnNext: el<HTMLButtonElement>('btnNext'),
  wizardStatus: el<HTMLParagraphElement>('wizardStatus'),
  summary: el<HTMLDListElement>('summary'),
  cronPreview: el<HTMLParagraphElement>('cronPreview'),
  issues: el<HTMLDivElement>('issues'),
  tabs: el<HTMLElement>('fileTabs'),
  fileName: el<HTMLHeadingElement>('fileName'),
  filePurpose: el<HTMLParagraphElement>('filePurpose'),
  fileContent: el<HTMLElement>('fileContent'),
  schemaChips: el<HTMLDivElement>('schemaChips'),
  mailFields: el<HTMLDivElement>('mailFields'),
  profileSelect: el<HTMLSelectElement>('profileSelect'),
  btnSaveProfile: el<HTMLButtonElement>('btnSaveProfile'),
  btnDeleteProfile: el<HTMLButtonElement>('btnDeleteProfile'),
  btnExportJson: el<HTMLButtonElement>('btnExportJson'),
  inputImportJson: el<HTMLInputElement>('inputImportJson'),
  btnReset: el<HTMLButtonElement>('btnReset'),
  btnDerivePaths: el<HTMLButtonElement>('btnDerivePaths'),
  btnCopy: el<HTMLButtonElement>('btnCopy'),
  btnDownload: el<HTMLButtonElement>('btnDownload'),
  btnDownloadAll: el<HTMLButtonElement>('btnDownloadAll'),
};

const stepSections = Array.from(ui.form.querySelectorAll<HTMLElement>('.step'));

/** Welche Prüfmeldung zu welchem Schritt gehört. */
const stepFields: ReadonlyArray<ReadonlyArray<ValidationIssue['field']>> = [
  ['customer', 'sid', 'instance', 'host', 'port', 'dbUser', 'osUser', 'userstoreKey'],
  ['hdbsqlPath', 'exportBase', 'scriptPath'],
  ['schemas'],
  ['threads', 'compression', 'keepRawExport', 'minFreeGb'],
  ['retentionDays', 'schedule'],
  ['mail'],
  [],
];

const RESULT_STEP = stepSections.length - 1;

let step = 0;
let lastDerived = derivedDefaults('', '00');
let activeFileName: string | null = null;
let currentFiles: GeneratedFile[] = [];

// -----------------------------------------------------------------------
//  Formular <-> Konfiguration
// -----------------------------------------------------------------------

function readForm(): ExportConfig {
  const [hourRaw = '2', minuteRaw = '0'] = fields.scheduleTime.value.split(':');
  const dowSelection = fields.scheduleDow.value;

  return {
    customer: fields.customer.value,
    sid: fields.sid.value,
    instance: fields.instance.value,
    host: fields.host.value,
    port: Number.parseInt(fields.port.value, 10),
    dbUser: fields.dbUser.value,
    osUser: fields.osUser.value,
    userstoreKey: fields.userstoreKey.value,
    hdbsqlPath: fields.hdbsqlPath.value,
    exportBase: fields.exportBase.value,
    scriptPath: fields.scriptPath.value,
    schemas: parseSchemaList(fields.schemas.value),
    threads: Number.parseInt(fields.threads.value, 10),
    retentionDays: Number.parseInt(fields.retentionDays.value, 10),
    compression: fields.compression.value as ExportConfig['compression'],
    keepRawExport: fields.keepRawExport.checked,
    minFreeGb: Number.parseInt(fields.minFreeGb.value, 10),
    schedule: {
      hour: Number.parseInt(hourRaw, 10),
      minute: Number.parseInt(minuteRaw, 10),
      dayOfWeek: dowSelection === '__custom' ? fields.scheduleDowCustom.value.trim() : dowSelection,
    },
    mail: {
      enabled: fields.mailEnabled.checked,
      recipient: fields.mailRecipient.value,
      command: fields.mailCommand.value,
      onlyOnError: fields.mailOnlyOnError.checked,
    },
  };
}

function writeForm(config: ExportConfig): void {
  fields.customer.value = config.customer;
  fields.sid.value = config.sid;
  fields.instance.value = config.instance;
  fields.host.value = config.host;
  fields.port.value = String(config.port);
  fields.dbUser.value = config.dbUser;
  fields.osUser.value = config.osUser;
  fields.userstoreKey.value = config.userstoreKey;
  fields.hdbsqlPath.value = config.hdbsqlPath;
  fields.exportBase.value = config.exportBase;
  fields.scriptPath.value = config.scriptPath;
  fields.schemas.value = config.schemas.join('\n');
  fields.threads.value = String(config.threads);
  fields.retentionDays.value = String(config.retentionDays);
  fields.compression.value = config.compression;
  fields.keepRawExport.checked = config.keepRawExport;
  fields.minFreeGb.value = String(config.minFreeGb);

  const { hour, minute, dayOfWeek } = config.schedule;
  fields.scheduleTime.value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const presets = Array.from(fields.scheduleDow.options).map((option) => option.value);
  if (presets.includes(dayOfWeek)) {
    fields.scheduleDow.value = dayOfWeek;
    fields.scheduleDowCustom.value = '';
  } else {
    fields.scheduleDow.value = '__custom';
    fields.scheduleDowCustom.value = dayOfWeek;
  }

  fields.mailEnabled.checked = config.mail.enabled;
  fields.mailRecipient.value = config.mail.recipient;
  fields.mailCommand.value = config.mail.command;
  fields.mailOnlyOnError.checked = config.mail.onlyOnError;

  lastDerived = derivedDefaults(config.sid, config.instance);
  syncConditionalFields();
}

/** Blendet Felder ein und aus, die von einer anderen Auswahl abhängen. */
function syncConditionalFields(): void {
  fields.scheduleDowCustom.hidden = fields.scheduleDow.value !== '__custom';
  ui.mailFields.hidden = !fields.mailEnabled.checked;
}

/**
 * Zieht Benutzer, Port und Pfade nach, solange sie leer sind oder noch genau
 * auf dem zuletzt vorgeschlagenen Wert stehen. Von Hand Geändertes bleibt.
 */
function syncDerivedFields(): void {
  const next = derivedDefaults(fields.sid.value.trim().toUpperCase(), fields.instance.value.trim());

  const adopt = (input: HTMLInputElement, previous: string, proposal: string): void => {
    if (proposal.length === 0) return;
    if (input.value.trim().length === 0 || input.value === previous) input.value = proposal;
  };

  adopt(fields.port, String(lastDerived.port), String(next.port));
  adopt(fields.osUser, lastDerived.osUser, next.osUser);
  adopt(fields.hdbsqlPath, lastDerived.hdbsqlPath, next.hdbsqlPath);
  adopt(fields.exportBase, lastDerived.exportBase, next.exportBase);
  adopt(fields.scriptPath, lastDerived.scriptPath, next.scriptPath);

  lastDerived = next;
}

// -----------------------------------------------------------------------
//  Wizard
// -----------------------------------------------------------------------

/** Prüfmeldungen, die den angegebenen Schritt betreffen. */
function issuesForStep(issues: ValidationIssue[], index: number): ValidationIssue[] {
  const owned = stepFields[index] ?? [];
  return issues.filter((issue) => owned.includes(issue.field));
}

/** Der erste Schritt, der noch einen blockierenden Fehler hat. */
function firstBlockedStep(issues: ValidationIssue[]): number | null {
  for (let index = 0; index < stepSections.length; index++) {
    if (issuesForStep(issues, index).some((issue) => issue.severity === 'error')) return index;
  }
  return null;
}

function goToStep(target: number): void {
  step = Math.max(0, Math.min(RESULT_STEP, target));
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderStepNav(issues: ValidationIssue[]): void {
  ui.stepNav.replaceChildren(
    ...stepSections.map((section, index) => {
      const blocked = issuesForStep(issues, index).some((issue) => issue.severity === 'error');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'steps__item';
      button.setAttribute('aria-current', String(index === step));
      if (blocked) button.dataset.state = 'blocked';
      else if (index < step) button.dataset.state = 'done';

      const number = document.createElement('span');
      number.className = 'steps__num';
      number.textContent = index === RESULT_STEP ? '✓' : String(index + 1);

      const label = document.createElement('span');
      label.textContent = section.dataset.title ?? `Schritt ${index + 1}`;

      button.append(number, label);
      button.addEventListener('click', () => goToStep(index));
      return button;
    }),
  );
}

// -----------------------------------------------------------------------
//  Darstellung
// -----------------------------------------------------------------------

function renderSchemaChips(config: ExportConfig): void {
  ui.schemaChips.replaceChildren(
    ...config.schemas.map((schema) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = schema;
      return chip;
    }),
  );
}

function renderIssues(issues: ValidationIssue[]): void {
  const relevant = step === RESULT_STEP ? issues : issuesForStep(issues, step);
  ui.issues.hidden = relevant.length === 0;
  ui.issues.replaceChildren(
    ...relevant.map((issue) => {
      const row = document.createElement('p');
      row.className = `issue issue--${issue.severity}`;
      row.textContent = issue.message;
      return row;
    }),
  );
}

function renderSummary(config: ExportConfig): void {
  const ext = archiveExtension(config.compression);
  const rows: Array<[string, string]> = [
    ['Kunde', config.customer || '–'],
    ['System', `${config.sid} (Instanz ${config.instance}) auf ${config.host}:${config.port}`],
    ['Anmeldung', `${config.dbUser} über hdbuserstore-Key ${config.userstoreKey}`],
    ['Linux-Benutzer', config.osUser],
    ['Schemas', `${config.schemas.join(', ')} – je ein eigenes Archiv`],
    ['Exportpfad', config.exportBase],
    ['Skriptpfad', config.scriptPath],
    ['Archiv', `${compressionLabel(config.compression)} als SCHEMA_JJJJ-MM-TT.${ext}`],
    ['Aufbewahrung', `${config.retentionDays} Tage`],
    ['Zeitplan', `${scheduleDescription(config)} – ${cronLine(config)}`],
    [
      'Mail',
      config.mail.enabled
        ? `${config.mail.recipient} (${config.mail.onlyOnError ? 'nur bei Fehlern' : 'nach jedem Lauf'})`
        : 'keine',
    ],
  ];

  ui.summary.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

function renderTabs(files: GeneratedFile[]): void {
  ui.tabs.replaceChildren(
    ...files.map((file) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.textContent = file.title;
      tab.setAttribute('aria-selected', String(file.name === activeFileName));
      tab.addEventListener('click', () => {
        activeFileName = file.name;
        render();
      });
      return tab;
    }),
  );
}

function activeFile(): GeneratedFile | undefined {
  return currentFiles.find((file) => file.name === activeFileName) ?? currentFiles[0];
}

function setActionsEnabled(enabled: boolean): void {
  ui.btnCopy.disabled = !enabled;
  ui.btnDownload.disabled = !enabled;
  ui.btnDownloadAll.disabled = !enabled;
}

function render(): void {
  const config = normalizeConfig(readForm());
  const issues = validateConfig(config);

  stepSections.forEach((section, index) => {
    section.hidden = index !== step;
  });

  renderStepNav(issues);
  renderIssues(issues);
  renderSchemaChips(config);
  syncConditionalFields();

  ui.cronPreview.textContent =
    config.scriptPath.length > 0
      ? `Crontab-Eintrag: ${cronLine(config)}`
      : 'Crontab-Eintrag erscheint, sobald der Skriptpfad feststeht.';

  // ---- Navigation --------------------------------------------------
  ui.btnBack.disabled = step === 0;
  ui.btnNext.hidden = step === RESULT_STEP;

  const blockedHere = issuesForStep(issues, step).some((issue) => issue.severity === 'error');
  ui.btnNext.disabled = blockedHere;
  ui.btnNext.textContent = step === RESULT_STEP - 1 ? 'Skripte erzeugen' : 'Weiter';

  const blocked = firstBlockedStep(issues);
  if (step === RESULT_STEP && blocked !== null) {
    ui.wizardStatus.textContent = `Es fehlt noch etwas in Schritt ${blocked + 1}.`;
  } else {
    ui.wizardStatus.textContent = `Schritt ${step + 1} von ${stepSections.length}`;
  }

  // ---- Ausgabe -----------------------------------------------------
  if (blocked !== null) {
    ui.tabs.replaceChildren();
    ui.summary.replaceChildren();
    ui.fileName.textContent = 'Noch keine Ausgabe';
    ui.filePurpose.textContent = 'Die Vorschau erscheint, sobald alle Pflichtangaben stehen.';
    ui.fileContent.textContent = '';
    currentFiles = [];
    setActionsEnabled(false);
    return;
  }

  currentFiles = generateAll(config);
  if (!currentFiles.some((file) => file.name === activeFileName)) {
    activeFileName = currentFiles[0]?.name ?? null;
  }

  renderSummary(config);
  renderTabs(currentFiles);

  const file = activeFile();
  if (file === undefined) return;

  ui.fileName.textContent = file.name;
  ui.filePurpose.textContent = file.purpose;
  ui.fileContent.textContent = file.content;
  setActionsEnabled(true);

  persist(LAST_CONFIG_KEY, config);
}

// -----------------------------------------------------------------------
//  Download und Zwischenablage
// -----------------------------------------------------------------------

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Etwas Luft lassen, sonst bricht der Download in manchen Browsern ab.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function flash(button: HTMLButtonElement, text: string): Promise<void> {
  const original = button.textContent;
  button.textContent = text;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  button.textContent = original;
}

// -----------------------------------------------------------------------
//  Kundenprofile
// -----------------------------------------------------------------------

type ProfileMap = Record<string, ExportConfig>;

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Privates Fenster oder blockierter Speicher – die UI funktioniert weiter.
  }
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function loadProfiles(): ProfileMap {
  return loadJson<ProfileMap>(PROFILE_STORAGE_KEY) ?? {};
}

function renderProfiles(selected = ''): void {
  const profiles = loadProfiles();
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b, 'de'));
  ui.profileSelect.replaceChildren(
    new Option('Kundenprofil laden…', ''),
    ...names.map((name) => new Option(name, name)),
  );
  ui.profileSelect.value = selected;
}

// -----------------------------------------------------------------------
//  Ereignisse
// -----------------------------------------------------------------------

ui.form.addEventListener('input', (event) => {
  if (event.target === fields.sid || event.target === fields.instance) syncDerivedFields();
  render();
});

ui.form.addEventListener('change', () => render());
ui.form.addEventListener('submit', (event) => event.preventDefault());

ui.btnNext.addEventListener('click', () => goToStep(step + 1));
ui.btnBack.addEventListener('click', () => goToStep(step - 1));

ui.btnDerivePaths.addEventListener('click', () => {
  const next = derivedDefaults(fields.sid.value.trim().toUpperCase(), fields.instance.value.trim());
  if (next.hdbsqlPath.length === 0) return;
  fields.port.value = String(next.port);
  fields.hdbsqlPath.value = next.hdbsqlPath;
  fields.exportBase.value = next.exportBase;
  fields.scriptPath.value = next.scriptPath;
  lastDerived = next;
  render();
});

ui.btnCopy.addEventListener('click', async () => {
  const file = activeFile();
  if (file === undefined) return;
  try {
    await navigator.clipboard.writeText(file.content);
    await flash(ui.btnCopy, 'Kopiert');
  } catch {
    // Ohne Clipboard-Recht bleibt das Markieren im Vorschaufenster.
    await flash(ui.btnCopy, 'Nicht erlaubt');
  }
});

ui.btnDownload.addEventListener('click', () => {
  const file = activeFile();
  if (file === undefined) return;
  downloadBlob(new Blob([file.content], { type: 'text/plain;charset=utf-8' }), file.name);
});

ui.btnDownloadAll.addEventListener('click', () => {
  if (currentFiles.length === 0) return;
  const config = normalizeConfig(readForm());
  const folder = `hana_schema_export_${customerSlug(config.customer, config.sid)}`;
  const zip = createZip(
    currentFiles.map((file) => ({
      name: `${folder}/${file.name}`,
      content: file.content,
      mode: file.executable ? 0o750 : 0o640,
    })),
  );
  downloadBlob(zip, `${folder}.zip`);
});

ui.btnSaveProfile.addEventListener('click', () => {
  const config = normalizeConfig(readForm());
  const name = window.prompt('Profilname', config.customer || config.sid);
  if (name === null || name.trim().length === 0) return;
  const profiles = loadProfiles();
  profiles[name.trim()] = config;
  persist(PROFILE_STORAGE_KEY, profiles);
  renderProfiles(name.trim());
});

ui.profileSelect.addEventListener('change', () => {
  const profile = loadProfiles()[ui.profileSelect.value];
  if (profile === undefined) return;
  writeForm({ ...defaultConfig(), ...profile });
  goToStep(RESULT_STEP);
});

ui.btnDeleteProfile.addEventListener('click', () => {
  const name = ui.profileSelect.value;
  if (name === '' || !window.confirm(`Profil "${name}" löschen?`)) return;
  const profiles = loadProfiles();
  delete profiles[name];
  persist(PROFILE_STORAGE_KEY, profiles);
  renderProfiles();
});

ui.btnExportJson.addEventListener('click', () => {
  const config = normalizeConfig(readForm());
  downloadBlob(
    new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
    `hana_export_${customerSlug(config.customer, config.sid)}.json`,
  );
});

ui.inputImportJson.addEventListener('change', async () => {
  const file = ui.inputImportJson.files?.[0];
  if (file === undefined) return;
  try {
    const parsed = JSON.parse(await file.text()) as Partial<ExportConfig>;
    writeForm({ ...defaultConfig(), ...parsed });
    goToStep(RESULT_STEP);
  } catch {
    window.alert('Die Datei konnte nicht als Konfiguration gelesen werden.');
  } finally {
    ui.inputImportJson.value = '';
  }
});

ui.btnReset.addEventListener('click', () => {
  if (!window.confirm('Alle Eingaben verwerfen und neu beginnen?')) return;
  writeForm(defaultConfig());
  activeFileName = null;
  goToStep(0);
});

// -----------------------------------------------------------------------
//  Start
// -----------------------------------------------------------------------

writeForm({ ...defaultConfig(), ...(loadJson<ExportConfig>(LAST_CONFIG_KEY) ?? {}) });
renderProfiles();
render();
