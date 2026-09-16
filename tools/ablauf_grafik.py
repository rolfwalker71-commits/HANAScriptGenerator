"""Erzeugt die Ablauf-Infografik als SVG.

Layout wird gerechnet statt von Hand gesetzt, damit die Abstaende stimmen
und sich Schritte ohne Nacharbeit ergaenzen lassen. Jeder Schritt fuehrt
saemtliche Aufrufparameter auf; die Kartenhoehe waechst entsprechend mit.
"""
from html import escape

TEAL, ORANGE = '#006887', '#f5a61a'
TEXT, MUTED, BORDER = '#1b2b33', '#5d6b73', '#d5dde1'
CARD, CODE_BG = '#ffffff', '#f2f5f7'

BREITE = 1180
RAND = 40
SPALTE = BREITE - 2 * RAND

# Je Schritt: Titel, Aufruf, Schalter [(Parameter, Bedeutung)], Hinweis.
phasen = [
    (TEAL, '1', 'Auf dem Windows-Rechner', 'Kein npm, keine Installation', [
        ('Wizard ausfüllen', 'HANAScriptGenerator.html doppelklicken', [],
         'Sieben Schritte. Pfade und Benutzer werden aus SID und Instanznummer vorgeschlagen.'),
        ('Schemas holen  ·  optional', '00_schemas_auslesen.cmd', [
            ('set USERSTORE_KEY=…', 'über einen hdbuserstore-Key statt Passwortabfrage'),
            ('set HANA_DB=…', 'einen anderen Tenant abfragen  (hdbsql -d)'),
        ],
         'Schreibt schemas.txt neben die Datei. Alternativ Befehl kopieren und Ausgabe einfügen.'),
        ('Skripte erzeugen', 'Alle als ZIP  →  vollständig entpacken', [],
         'Dabei sind export.conf und export_schemas.txt. Alles gehört in einen Ordner.'),
        ('Auf den Server übertragen', '00_dateien_uebertragen.cmd', [
            ('--key', 'einmalig SSH-Schlüssel einrichten, danach ohne Passwort'),
            ('--scp', 'Einzelschritte statt einem Durchgang, falls tar fehlt'),
        ],
         'Setzt Zeilenenden, chmod 750, Gruppe sapsys. Dort gepflegte export.conf und '
         'export_schemas.txt bleiben stehen.'),
    ]),
    (ORANGE, '2', 'Auf dem HANA-Server', 'Alles als <sid>adm — der hdbuserstore ist benutzerspezifisch', [
        ('Anmelden', 'su - <sid>adm   →   cd <SKRIPTPFAD>', [],
         'Kontrolle:  whoami  &&  ls -l *.sh'),
        ('Userstore-Key anlegen', './01_setup_userstore.sh', [],
         'Ohne Parameter. Passwort wird verdeckt abgefragt und landet nie in einer Datei.'),
        ('Verzeichnisse anlegen', './02_prepare_dirs.sh', [],
         'Ohne Parameter. Prüft jedes Verzeichnis einzeln auf Schreibrecht.'),
        ('Vorabprüfung', './03_preflight.sh', [],
         'Ohne Parameter. ERST WEITER, WENN FEHLERFREI. Ändert nichts, beliebig wiederholbar.'),
        ('Testexport', './04_test_export.sh', [
            ('[SCHEMA]', 'dieses Schema statt des ersten aus export_schemas.txt'),
            ('--keep', 'Testdaten liegen lassen statt sie zu entfernen'),
        ],
         'Beweist Export und tar-Lauf, bevor Cron übernimmt. Zeigt auch die Laufzeit.'),
        ('StorageBox einrichten  ·  falls Auslagerung', './06_offload_storagebox.sh', [
            ('--setup', 'Schlüssel anlegen, auf der Box ablegen, Anmeldung prüfen'),
            ('--check', 'nur die Anmeldung prüfen, nichts übertragen'),
        ],
         'Wiederholen schadet nicht. --setup-key und --install-key sind ältere Namen für --setup.'),
        ('Erster echter Lauf', '<SKRIPTPFAD>/schema_export.sh   →   echo $?', [],
         'Ohne Parameter, alles Weitere steht in export.conf. Muss 0 ergeben.'),
        ('Einplanen', './05_install_cron.sh', [
            ('(ohne)', 'Einträge setzen oder aktualisieren'),
            ('--show', 'nur anzeigen, nichts ändern'),
            ('--remove', 'Einträge wieder entfernen'),
        ],
         'Setzt zwei Zeilen: Export und Auslagerung. Kontrolle:  crontab -l'),
    ]),
    (TEAL, '3', 'Betrieb', 'Läuft von selbst', [
        ('Täglich', 'Export  →  Archivierung  →  Auslagerung  →  Aufräumen', [],
         'Alles eines Tages in einem Tagesordner. Nach Ablauf der Frist fällt er als Ganzes weg.'),
        ('Log ansehen', 'tail -50 "$(ls -1t <EXPORTPFAD>/logs/schema_export_*.log | head -1)"', [],
         'Jede Zeile mit Zeitstempel. Alte Logs verschwinden mit derselben Frist.'),
        ('Einstellungen ändern', 'vi <SKRIPTPFAD>/export.conf', [],
         'Aufbewahrung, Threads, Mindestplatz, Mail, StorageBox. Ein ungültiger Wert hält den Lauf an.'),
        ('Schemas ändern', 'vi <SKRIPTPFAD>/export_schemas.txt', [],
         'Ein Schema pro Zeile, # kommentiert aus. Beides gilt ab dem nächsten Lauf: '
         'danach ./03_preflight.sh, Skripte und Crontab bleiben unverändert.'),
        ('Auslagern von Hand  ·  falls Auslagerung', './06_offload_storagebox.sh', [
            ('(ohne)', 'den heutigen Tagesordner übertragen'),
            ('JJJJ-MM-TT', 'genau diesen Tag noch einmal übertragen'),
            ('--pending', 'alles nachholen, was noch keinen Vermerk hat'),
            ('--check', 'nur die Verbindung prüfen'),
        ],
         'Der Cronjob macht das ohnehin täglich. --pending hilft nach einer Nacht ohne Netz.'),
        ('Wiederherstellen', './90_restore_schema.sh', [
            ('--list', 'vorhandene Archive auflisten  (auch ohne Angabe)'),
            ('SCHEMA JJJJ-MM-TT', 'Archiv entpacken, die Datenbank bleibt unberührt'),
            ('--import', 'zusätzlich zurückspielen — überschreibt, fragt vorher nach'),
        ],
         'Der IMPORT verlangt den Schemanamen als Bestätigung.'),
    ]),
]

# ---------------------------------------------------------------- Layout
KOPF_H, LUECKE, PHASE_LUECKE = 66, 10, 24
SCHRITT_H = 96          # Titel, Aufruf, Hinweis
SCHALTER_H = 21         # je Schalterzeile
SCHALTER_LUECKE = 8     # Abstand vor dem Hinweis
TITEL_H = 116

# Zeichenbreiten der verwendeten Groessen, grob geschaetzt.
MONO_BREITE = 13.5 * 0.60


def schritt_hoehe(schalter):
    if not schalter:
        return SCHRITT_H
    return SCHRITT_H + len(schalter) * SCHALTER_H + SCHALTER_LUECKE


teile = []
y = TITEL_H

for farbe, nummer, titel, unter, schritte in phasen:
    hoehe = KOPF_H + sum(schritt_hoehe(s[2]) + LUECKE for s in schritte) + 14
    teile.append(('phase', y, hoehe, farbe, nummer, titel, unter, schritte))
    y += hoehe + PHASE_LUECKE

HOEHE = y - PHASE_LUECKE + 30


def e(t):
    return escape(str(t), quote=True)


svg = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{BREITE}" height="{HOEHE}" '
    f'viewBox="0 0 {BREITE} {HOEHE}" font-family="Segoe UI, Helvetica, Arial, sans-serif">',
    f'<rect width="{BREITE}" height="{HOEHE}" fill="#eef2f4"/>',
    f'<text x="{RAND}" y="52" font-size="30" font-weight="700" fill="{TEXT}">'
    'SAP HANA Schema-Export — Ausrollen beim Kunden</text>',
    f'<text x="{RAND}" y="80" font-size="16" fill="{MUTED}">'
    'Reihenfolge der Schritte vom Wizard bis zum laufenden Cronjob, mit allen Aufrufparametern</text>',
    f'<text x="{RAND}" y="102" font-size="13" fill="{MUTED}">'
    'Erzeugt durch HANAScriptGenerator</text>',
]

nr = 0
for _, y0, hoehe, farbe, nummer, titel, unter, schritte in teile:
    svg.append(f'<rect x="{RAND}" y="{y0}" width="{SPALTE}" height="{hoehe}" rx="14" '
               f'fill="{CARD}" stroke="{BORDER}"/>')
    svg.append(f'<path d="M {RAND} {y0+14} a 14 14 0 0 1 14 -14 h {SPALTE-28} '
               f'a 14 14 0 0 1 14 14 v {KOPF_H-14} h -{SPALTE} z" fill="{farbe}"/>')
    svg.append(f'<circle cx="{RAND+34}" cy="{y0+KOPF_H/2}" r="17" fill="#ffffff" opacity="0.9"/>')
    svg.append(f'<text x="{RAND+34}" y="{y0+KOPF_H/2+7}" font-size="19" font-weight="700" '
               f'fill="{farbe}" text-anchor="middle">{nummer}</text>')
    svg.append(f'<text x="{RAND+66}" y="{y0+30}" font-size="20" font-weight="700" '
               f'fill="#ffffff">{e(titel)}</text>')
    svg.append(f'<text x="{RAND+66}" y="{y0+50}" font-size="13.5" fill="#ffffff" '
               f'opacity="0.85">{e(unter)}</text>')

    sy = y0 + KOPF_H + 12
    for name, befehl, schalter, hinweis in schritte:
        nr += 1
        hoehe_s = schritt_hoehe(schalter)

        svg.append(f'<rect x="{RAND+14}" y="{sy}" width="{SPALTE-28}" height="{hoehe_s}" '
                   f'rx="9" fill="{CODE_BG}"/>')
        svg.append(f'<rect x="{RAND+14}" y="{sy}" width="4" height="{hoehe_s}" fill="{farbe}"/>')
        svg.append(f'<circle cx="{RAND+46}" cy="{sy+26}" r="13" fill="{farbe}"/>')
        svg.append(f'<text x="{RAND+46}" y="{sy+31}" font-size="13" font-weight="700" '
                   f'fill="#ffffff" text-anchor="middle">{nr}</text>')
        svg.append(f'<text x="{RAND+70}" y="{sy+24}" font-size="16.5" font-weight="600" '
                   f'fill="{TEXT}">{e(name)}</text>')
        svg.append(f'<text x="{RAND+70}" y="{sy+50}" font-size="15" fill="{farbe}" '
                   f'font-family="DejaVu Sans Mono, Consolas, monospace">{e(befehl)}</text>')

        # Die Bedeutungen stehen in einer Spalte, ausgerichtet am laengsten
        # Parameter dieses Schritts.
        zy = sy + 72
        if schalter:
            spalte_x = RAND + 86 + int(max(len(p) for p, _ in schalter) * MONO_BREITE) + 14
            for parameter, bedeutung in schalter:
                svg.append(f'<text x="{RAND+86}" y="{zy}" font-size="13.5" fill="{farbe}" '
                           f'font-family="DejaVu Sans Mono, Consolas, monospace">{e(parameter)}</text>')
                svg.append(f'<text x="{spalte_x}" y="{zy}" font-size="13.5" fill="{TEXT}">'
                           f'{e(bedeutung)}</text>')
                zy += SCHALTER_H
            zy += SCHALTER_LUECKE

        svg.append(f'<text x="{RAND+70}" y="{zy+2}" font-size="13" fill="{MUTED}">{e(hinweis)}</text>')
        sy += hoehe_s + LUECKE

svg.append('</svg>')
open('ablauf.svg', 'w').write('\n'.join(svg))
print(f'SVG geschrieben: {BREITE} x {HOEHE}, {nr} Schritte')
