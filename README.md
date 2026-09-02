# DB Navigator Widgets für Home Assistant

Eine eigenständige Lovelace-Karte im Stil der mobilen DB-Navigator-App. Die Integration stellt **nur das Widget** bereit und ruft selbst keine Fahrtdaten ab. Verbindungen kommen aus einer bereits vorhandenen DB-Info-Integration.

> Community-Projekt, nicht von der Deutschen Bahn AG entwickelt oder unterstützt. „DB“ und „DB Navigator“ sind Marken ihrer jeweiligen Rechteinhaber.

## Funktionen

- native Custom Card, **keine Abhängigkeit von `custom:button-card`**
- geplante und reale Abfahrts-/Ankunftszeit inklusive Verspätung
- Produktfarben für ICE/IC, RE/RB, S-Bahn, Stadtbahn, Bus, MEX, Tram und einheitlich normalisiertes SEV
- Umstiegszeit aus den einzelnen Fahrtabschnitten; knappe Umstiege bis 2 Minuten werden rot hervorgehoben
- Start, Ziel, Gleise, Dauer, Umstiege und Störungsmeldungen
- mehrere Strecken in einer Karte, jeweils unabhängig ein- und ausklappbar
- eingeklappte Strecken zeigen rechts die nächste Abfahrt und die zugehörigen Verkehrsmittel
- jede Verbindung per Klick aufklappbar mit vollständigem Reiseverlauf, Haltestellen, Soll-/Echtzeiten, Gleisen, Verkehrsmitteln, Meldungen und Datenquelle
- wählbare Darstellung: Home-Assistant-Theme, explizit **Hell** oder **Dunkel**
- Navigator-Navigation mit **Früher**, **Jetzt**, **Später** und frei wählbarer Abfahrtszeit
- direkte Nutzung der `datetime`-, `switch`- und `button`-Entities von [EiS94/db_info](https://github.com/EiS94/db_info)
- responsive Darstellung und Dark Mode
- Klick auf eine Verbindung öffnet den Home-Assistant-Mehr-Info-Dialog
- feste Entity-Liste, nummeriertes Präfix oder automatische Erkennung
- optionaler Richtungswechsel über eine `person`-Entity
- visueller Karteneditor inklusive JSON-Konfiguration mehrerer Strecken

## Installation über HACS

1. Dieses Repository in HACS unter **Integrationen → Benutzerdefinierte Repositories** als Kategorie **Integration** hinzufügen.
2. **DB Navigator Widgets** herunterladen.
3. Home Assistant neu starten.
4. Unter **Einstellungen → Geräte & Dienste → Integration hinzufügen** „DB Navigator Widgets“ auswählen und bestätigen.
5. Unter **Einstellungen → Dashboards → Ressourcen** diese Ressource hinzufügen:

```text
/db_navigator_widget_static/db-navigator-card.js
```

Typ: **JavaScript-Modul**. Danach das Dashboard neu laden. Die Ressource wird bewusst nicht automatisch in die Lovelace-Konfiguration geschrieben.

### Manuelle Installation

Den Ordner `custom_components/db_navigator_widget` nach `/config/custom_components/db_navigator_widget` kopieren, Home Assistant neu starten und dann mit Schritt 4 fortfahren.

## Karte verwenden

### Mehrere ein- und ausklappbare Strecken

Jeder Eintrag unter `routes` entspricht einem DB-Info-Konfigurationseintrag. Das Widget findet dessen fünf Verbindungssensoren sowie Zeitsteuerungs-Entities normalerweise automatisch:

```yaml
type: custom:db-navigator-card
title: Meine Reisen
appearance: light  # auto, light oder dark
max_connections: 5
routes:
  - title: Bahnhof → Arbeit
    entity_prefix: sensor.bahnhof_arbeit_verbindung_
    open: true
  - title: Arbeit → Bahnhof
    entity_prefix: sensor.arbeit_bahnhof_verbindung_
    open: false
  - title: Zuhause → Hauptbahnhof
    entities:
      - sensor.zuhause_hauptbahnhof_verbindung_1
      - sensor.zuhause_hauptbahnhof_verbindung_2
      - sensor.zuhause_hauptbahnhof_verbindung_3
```

Ein Klick auf den Streckenkopf klappt die jeweilige Strecke auf oder zu. Ein Klick auf eine einzelne Verbindung öffnet direkt darunter den vollständigen Reiseverlauf. Der Info-Button im geöffneten Verlauf öffnet zusätzlich den Home-Assistant-Mehr-Info-Dialog. `entities` hat innerhalb einer Strecke Vorrang vor `entity_prefix`.

### Früher, Jetzt, Später und eigene Uhrzeit

DB Info stellt je Strecke neben fünf Sensoren diese Entities bereit:

- `datetime.…_abfahrtszeit`
- `switch.…_benutzerdefinierte_zeit_verwenden`
- `button.…_refresh`

Das Widget leitet die IDs aus dem Sensorpräfix ab. Falls Home Assistant abweichende Entity-IDs erzeugt hat, können sie explizit angegeben werden:

```yaml
type: custom:db-navigator-card
title: Meine Reisen
routes:
  - title: Bahnhof → Arbeit
    entity_prefix: sensor.bahnhof_arbeit_verbindung_
    datetime_entity: datetime.bahnhof_arbeit_abfahrtszeit
    custom_time_entity: switch.bahnhof_arbeit_benutzerdefinierte_zeit_verwenden
    refresh_entity: button.bahnhof_arbeit_refresh
```

- **Später** setzt die DB-Info-Abfahrtszeit eine Minute hinter die letzte sichtbare Verbindung.
- **Früher** kehrt zunächst zum vorherigen Suchzeitpunkt zurück; ohne Verlauf wird um `navigation_step_minutes` zurückgesprungen.
- **Jetzt** deaktiviert die benutzerdefinierte Zeit und lädt aktuelle Verbindungen.
- **Suchen** übernimmt die frei ausgewählte lokale Abfahrtszeit.

Die Karte schreibt zuerst `datetime.set_value`, aktiviert danach den Custom-Time-Schalter und stößt bei bereits aktivem Schalter den streckenspezifischen Refresh-Button an. Nur als Fallback wird `db_info.refresh_all` verwendet.

### Automatischer Richtungswechsel als einzelne dynamische Strecke

Die bisherige Konfiguration bleibt abwärtskompatibel:

```yaml
type: custom:db-navigator-card
title: Pendeln
person_entity: person.ferdinand
home_state: home
home_prefix: sensor.bahnhof_arbeit_verbindung_
away_prefix: sensor.arbeit_bahnhof_verbindung_
max_connections: 5
```

Für getrennt ein- und ausklappbare Richtungen sollten stattdessen zwei `routes`-Einträge verwendet werden.

## Kartenoptionen

| Option | Standard | Beschreibung |
|---|---:|---|
| `title` | `Meine Reisen` | Überschrift der Karte |
| `appearance` | `auto` | `auto` folgt dem HA-Theme; `light` erzwingt den hellen und `dark` den dunklen Navigator-Look |
| `routes` | – | Liste von Streckenobjekten; unterstützt `title`, `entity_prefix`, `entities`, `open` und die drei Control-Entities |
| `entities` | – | Legacy: Liste der Verbindungssensoren einer einzelnen Strecke |
| `entity_prefix` | – | Legacy: Präfix der Sensoren einer einzelnen Strecke |
| `max_connections` | `5` | Anzahl je Strecke, 1 bis 12 |
| `person_entity` | – | Entity für den Richtungswechsel |
| `home_state` | `home` | Status, bei dem `home_prefix` aktiv ist |
| `home_prefix` | – | Sensorpräfix für zuhause |
| `away_prefix` | – | Sensorpräfix für alle anderen Statuswerte |
| `show_header` | `true` | Kopfzeile anzeigen |
| `show_route` | `true` | Start/Ziel unter jedem Fahrtblock anzeigen |
| `show_platforms` | `true` | Gleise anzeigen, sofern vorhanden |
| `show_time_picker` | `true` | Auswahl einer freien Abfahrtszeit anzeigen |
| `navigation_step_minutes` | `60` | Rücksprung von „Früher“, wenn noch kein Navigationsverlauf existiert |
| `locale` | `de-DE` | Locale für die Zeitanzeige |

Streckenoptionen überschreiben die gleichnamige globale Option. `datetime_entity`, `custom_time_entity` und `refresh_entity` können pro Strecke explizit gesetzt werden.

## Erwartete DB-Info-Attribute

Die Karte akzeptiert die Attribute aus dem gezeigten DB-Info-Sensor direkt:

- `Departure`, `Arrival`
- `Departure Time`, `Departure Time Real`
- `Arrival Time`, `Arrival Time Real`
- `Duration`, `Transfers`, `Problems`, `Name`
- `Details` als echte Liste, JSON-String oder Python-ähnlicher String

Ein `Details`-Element kann zusätzlich `Departure Platform`, `Arrival Platform` und die jeweiligen geplanten/reellen Zeiten enthalten. `null` bei einer Realzeit wird als pünktlich bzw. noch ohne Echtzeitwert behandelt. Snake-Case-Varianten wie `departure_time` werden ebenfalls erkannt.

## Entwicklung und Tests

```bash
node --check custom_components/db_navigator_widget/www/db-navigator-card.js
node --test tests/card.test.mjs
python3 -m py_compile custom_components/db_navigator_widget/*.py
```

## Lizenz

MIT – siehe [LICENSE](LICENSE).
