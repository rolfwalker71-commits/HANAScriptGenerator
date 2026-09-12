# Logo

Eine Datei hier ablegen, dann wird sie beim Build fest in
`HANAScriptGenerator.html` eingebettet und muss nie mitkopiert werden:

| Datei | Vorrang |
| --- | --- |
| `assets/logo.svg` | 1. – am schärfsten, weil vektorbasiert |
| `assets/logo.png` | 2. |
| `assets/logo.webp` | 3. |
| `assets/logo.jpg` | 4. |

Danach `npm run build`. Fehlt die Datei, verschwindet das Bild-Element
ersatzlos und die Oberfläche funktioniert unverändert.

Die Datei landet als data-URI in der HTML-Datei und zählt damit voll zur
Dateigröße – für die Kopfzeile genügen rund 300 Pixel Breite.

## Hintergrund freistellen

`logo-original.png` ist die unveränderte Vorlage mit deckend weißem
Hintergrund. `logo.png` ist daraus freigestellt, damit das Logo ohne Platte
direkt auf der Kopfzeile stehen kann.

Weiß wird dabei nicht hart ausgestanzt: zwischen den Helligkeiten 200 und 250
läuft die Deckkraft weich aus. Ein harter Schnitt hinterließe an den
Buchstabenkanten weiße Fransen, die auf dunklem Grund auffallen. Volltonflächen
bleiben farblich unangetastet.

Bei einer neuen Vorlage lässt sich das mit wenigen Zeilen wiederholen; eine
Fassung mit transparentem Hintergrund oder als SVG braucht den Schritt nicht.
