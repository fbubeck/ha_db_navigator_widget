import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const registry = new Map();
globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
    return this.shadowRoot;
  }
  dispatchEvent() {}
};
globalThis.customElements = {
  define: (name, value) => registry.set(name, value),
  get: (name) => registry.get(name),
};
globalThis.window = { customCards: [] };
globalThis.CustomEvent = class {};

const source = readFileSync(
  new URL("../custom_components/db_navigator_widget/www/db-navigator-card.js", import.meta.url),
  "utf8",
);
vm.runInThisContext(source);
const Card = registry.get("db-navigator-card");

function makeCard(config = {}) {
  const card = new Card();
  card.setConfig({ max_connections: 5, ...config });
  return card;
}

test("parses DB Info details supplied as an array", () => {
  const card = makeCard();
  const details = [{ Name: "S6" }, { Name: "Fußweg" }, { Name: "Stadtbahn U6" }];
  assert.deepEqual(card._parseDetails(details), details);
});

test("parses Python-style details strings from HA attributes", () => {
  const card = makeCard();
  const details = card._parseDetails("[{'Name': 'S6', 'Departure Time Real': None}, {'Name': 'Fußweg'}]");
  assert.equal(details.length, 2);
  assert.equal(details[0].Name, "S6");
  assert.equal(details[0]["Departure Time Real"], null);
});

test("calculates delay across ISO timestamps with compact offsets", () => {
  const card = makeCard();
  assert.equal(
    card._delayMinutes("2026-09-01T17:32:00+0200", "2026-09-01T17:39:00+0200"),
    7,
  );
});

test("selects the direction prefix from a person state", () => {
  const card = makeCard({
    person_entity: "person.ferdinand",
    home_state: "home",
    home_prefix: "sensor.outbound_",
    away_prefix: "sensor.inbound_",
  });
  card._hass = { states: { "person.ferdinand": { state: "home" } } };
  assert.equal(card._activePrefix(), "sensor.outbound_");
  card._hass.states["person.ferdinand"].state = "work";
  assert.equal(card._activePrefix(), "sensor.inbound_");
});

test("recognizes and resolves numbered DB Info sensors", () => {
  const card = makeCard({ entity_prefix: "sensor.route_", max_connections: 2 });
  const attributes = {
    Departure: "Leonberg",
    Arrival: "Schlossplatz",
    "Departure Time": "2026-09-01T17:32:00+0200",
  };
  card._hass = {
    states: {
      "sensor.route_1": { entity_id: "sensor.route_1", state: "Verbindung 1", attributes },
      "sensor.route_2": { entity_id: "sensor.route_2", state: "Verbindung 2", attributes },
      "sensor.route_3": { entity_id: "sensor.route_3", state: "Verbindung 3", attributes },
    },
  };
  const route = card._normalizedRoutes()[0];
  assert.deepEqual(card._resolveRouteStates(route).map((state) => state.entity_id), ["sensor.route_1", "sensor.route_2"]);
});

test("normalizes every replacement-service label to one SEV badge", () => {
  const card = makeCard();
  assert.deepEqual(card._transport("SEV SEV"), { kind: "replacement", label: "SEV" });
  assert.deepEqual(card._transport("Bus Schienenersatzverkehr SEV"), { kind: "replacement", label: "SEV" });
});

test("shows departure and products in a collapsed route preview", () => {
  const card = makeCard();
  const html = card._renderRoutePreview({
    attributes: {
      Name: "Bus X2 -> Fußweg -> S6",
      Details: [{ Name: "Bus X2" }, { Name: "Fußweg" }, { Name: "S6" }],
    },
  }, "2026-09-01T17:32:00+0200");
  assert.match(html, /Abfahrt/);
  assert.match(html, />Bus X2</);
  assert.match(html, />S6</);
  assert.equal((html.match(/SEV/g) || []).length, 0);
});

test("renders the selectable light appearance", () => {
  const card = makeCard({ appearance: "light", entity_prefix: "sensor.route_" });
  card.hass = { states: {} };
  assert.match(card.shadowRoot.innerHTML, /<ha-card class="theme-light density-comfortable">/);
});

test("supports a selectable compact density", () => {
  const card = makeCard({ density: "compact", entity_prefix: "sensor.route_" });
  card.hass = { states: {} };
  assert.match(card.shadowRoot.innerHTML, /density-compact/);
});

test("calculates live departure countdown states", () => {
  const card = makeCard();
  const now = new Date("2026-09-01T17:00:00+0200").getTime();
  assert.deepEqual(card._countdownInfo("2026-09-01T17:04:00+0200", now), { minutes: 4, status: "soon", label: "in 4 Min." });
  assert.deepEqual(card._countdownInfo("2026-09-01T16:58:00+0200", now), { minutes: -2, status: "departed", label: "vor 2 Min." });
});

test("classifies transfer risk from realtime arrival and departure", () => {
  const card = makeCard();
  const previous = { "Arrival Time": "2026-09-01T17:10:00+0200", "Arrival Time Real": "2026-09-01T17:14:00+0200" };
  const next = { "Departure Time": "2026-09-01T17:16:00+0200" };
  assert.deepEqual(card._transferInfo(previous, next), { minutes: 2, status: "critical", label: "Umstieg gefährdet" });
});

test("highlights platform changes when realtime platform data exists", () => {
  const card = makeCard();
  const html = card._renderPlatform({ "Departure Platform Planned": "2", "Departure Platform Real": "4" }, "departure");
  assert.match(html, /<s>Gleis 2<\/s><strong>Gleis 4<\/strong>/);
});

test("translates DB Info problem enums and marks the affected connection strip", () => {
  const card = makeCard();
  assert.deepEqual(card._problemInfo("TrainProblem.CANCELED"), { kind: "cancelled", label: "Verbindung fällt aus" });
  assert.deepEqual(card._problemInfo("TrainProblem.CHANGE_NOT_ACCESSIBLE"), { kind: "connection", label: "Anschluss gefährdet" });
  const html = card._renderSegments({
    Problems: "TrainProblem.CANCELED",
    Details: [{ Name: "S6", Departure: "A", Arrival: "B" }, { Name: "U6", Departure: "B", Arrival: "C" }],
  });
  assert.equal((html.match(/ affected/g) || []).length, 1);
  assert.match(html, /Verbindung fällt aus/);
});

test("ranks fastest, earliest and lowest-transfer journeys", () => {
  const card = makeCard();
  const states = [
    { entity_id: "sensor.fast", attributes: { "Departure Time": "2026-09-01T17:00:00+0200", "Arrival Time": "2026-09-01T17:30:00+0200", Transfers: 0 } },
    { entity_id: "sensor.slow", attributes: { "Departure Time": "2026-09-01T16:50:00+0200", "Arrival Time": "2026-09-01T17:40:00+0200", Transfers: 1 } },
  ];
  const rankings = card._journeyRankings(states);
  assert.deepEqual(rankings["sensor.fast"], ["Früheste Ankunft", "Schnellste", "Direkt"]);
  assert.deepEqual(rankings["sensor.slow"], []);
});

test("renders a continuous timeline with a connected dashed walking section", () => {
  const card = makeCard();
  const styles = card._styles();
  assert.match(styles, /\.legs::before[\s\S]*bottom:5px/);
  assert.match(styles, /\.walk-detail::after[\s\S]*border-left:2px dashed/);
  assert.match(styles, /\.walk-detail::after[\s\S]*top:-7px; bottom:-7px/);
});

test("renders compact segment stops and platforms without summary fact tiles", () => {
  const card = makeCard();
  const state = {
    entity_id: "sensor.route_1",
    attributes: {
      Duration: "34min",
      Transfers: 1,
      Name: "S60 -> Fußweg -> Stadtbahn U6",
      Source: "bahnland-bayern.de",
      Details: [{
        Name: "S60",
        Departure: "Leonberg",
        "Departure Time": "2026-09-01T17:32:00+0200",
        "Departure Platform": "1",
        Arrival: "Feuerbach",
        "Arrival Time": "2026-09-01T17:51:00+0200",
        "Arrival Platform": "1a",
      }],
    },
  };
  const html = card._renderJourneyDetails(state);
  assert.match(html, /Leonberg/);
  assert.match(html, /Feuerbach/);
  assert.match(html, /Gleis 1a/);
  assert.doesNotMatch(html, /detail-fact/);
  assert.doesNotMatch(html, /bahnland-bayern\.de/);
  assert.equal((html.match(/class="stop-product suburban">S60/g) || []).length, 2);
  assert.match(html, /class="stop-kind">Ab[\s\S]*S60[\s\S]*Leonberg/);
  assert.match(html, /class="stop-kind">An[\s\S]*S60[\s\S]*Feuerbach/);
});

test("supports multiple independently collapsible route definitions", () => {
  const card = makeCard({
    routes: [
      { title: "Home → Work", entity_prefix: "sensor.home_work_verbindung_" },
      { title: "Work → Home", entity_prefix: "sensor.work_home_verbindung_", open: false },
    ],
  });
  assert.equal(card._normalizedRoutes().length, 2);
  assert.equal(card._routeKey(card._normalizedRoutes()[0]), "sensor.home_work_verbindung_");
});

test("infers DB Info custom-time controls from a route prefix", () => {
  const card = makeCard({ entity_prefix: "sensor.home_work_verbindung_" });
  card._hass = {
    states: {
      "datetime.home_work_abfahrtszeit": { state: "2026-09-01T17:00:00+02:00", attributes: {} },
      "switch.home_work_benutzerdefinierte_zeit_verwenden": { state: "off", attributes: {} },
      "button.home_work_refresh": { state: "unknown", attributes: {} },
    },
  };
  const controls = card._routeControls(card._normalizedRoutes()[0], []);
  assert.deepEqual(controls, {
    datetime: "datetime.home_work_abfahrtszeit",
    customTime: "switch.home_work_benutzerdefinierte_zeit_verwenden",
    refresh: "button.home_work_refresh",
  });
});

test("uses DB Info datetime and custom-time switch for a time request", async () => {
  const card = makeCard({
    entity_prefix: "sensor.home_work_verbindung_",
    datetime_entity: "datetime.home_work_abfahrtszeit",
    custom_time_entity: "switch.home_work_benutzerdefinierte_zeit_verwenden",
  });
  const calls = [];
  card._hass = {
    states: {
      "datetime.home_work_abfahrtszeit": { state: "2026-09-01T17:00:00+02:00", attributes: {} },
      "switch.home_work_benutzerdefinierte_zeit_verwenden": { state: "off", attributes: {} },
    },
    callService: async (...args) => calls.push(args),
  };
  const route = card._normalizedRoutes()[0];
  await card._setRouteTime({ route, key: card._routeKey(route), states: [] }, new Date(2026, 8, 1, 18, 30, 0));
  assert.deepEqual(calls.map(([domain, service]) => `${domain}.${service}`), [
    "datetime.set_value",
    "switch.turn_on",
  ]);
  assert.equal(calls[0][2].entity_id, "datetime.home_work_abfahrtszeit");
  assert.match(calls[0][2].datetime, /^2026-09-01T18:30:00$/);
});

test("later navigation starts after the final displayed departure and earlier restores history", () => {
  const card = makeCard({ entity_prefix: "sensor.route_verbindung_" });
  card._hass = { states: {} };
  const route = card._normalizedRoutes()[0];
  const states = [
    { attributes: { "Departure Time": "2026-09-01T17:00:00+0200" } },
    { attributes: { "Departure Time": "2026-09-01T18:00:00+0200" } },
  ];
  const routeData = { route, key: card._routeKey(route), states };
  assert.equal(card._navigationTarget(routeData, "later").getTime(), new Date("2026-09-01T18:01:00+0200").getTime());
  assert.equal(card._navigationTarget(routeData, "earlier").getTime(), new Date("2026-09-01T17:00:00+0200").getTime());
});
