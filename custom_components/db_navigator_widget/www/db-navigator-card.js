const DB_NAVIGATOR_CARD_VERSION = "0.4.1";

class DBNavigatorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._lastSignature = "";
    this._expandedRoutes = {};
    this._expandedJourneys = {};
    this._loadingRoutes = {};
    this._navigationHistory = {};
  }

  setConfig(config) {
    if (!config) throw new Error("Konfiguration fehlt");
    this._config = {
      title: "Meine Reisen",
      max_connections: 5,
      home_state: "home",
      show_header: true,
      show_route: true,
      show_platforms: true,
      show_time_picker: true,
      navigation_step_minutes: 60,
      appearance: "auto",
      density: "comfortable",
      ...config,
    };
    this._lastSignature = "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    if (this._clockTimer) return;
    this._clockTimer = setInterval(() => {
      this._lastSignature = "";
      this._render();
    }, 30000);
  }

  disconnectedCallback() {
    clearInterval(this._clockTimer);
    this._clockTimer = null;
  }

  getCardSize() {
    const routeCount = Math.max(1, this._normalizedRoutes?.().length || 1);
    const connections = Number(this._config?.max_connections || 5);
    return Math.max(2, Math.min(12, routeCount + connections + 1));
  }

  static getStubConfig() {
    return {
      type: "custom:db-navigator-card",
      title: "Meine Reisen",
      routes: [
        {
          title: "Bahnhof → Arbeit",
          entity_prefix: "sensor.bahnhof_arbeit_verbindung_",
        },
      ],
      max_connections: 5,
    };
  }

  static getConfigElement() {
    return document.createElement("db-navigator-card-editor");
  }

  _escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  _attr(attributes, ...names) {
    for (const name of names) {
      const value = attributes?.[name];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  }

  _asDate(value) {
    if (!value) return null;
    const normalized = String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  _formatTime(value) {
    const date = this._asDate(value);
    if (!date) {
      const match = String(value || "").match(/T(\d{2}:\d{2})/);
      return match?.[1] || "—";
    }
    return new Intl.DateTimeFormat(this._config?.locale || "de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  _delayMinutes(planned, real) {
    const plannedDate = this._asDate(planned);
    const realDate = this._asDate(real);
    if (!plannedDate || !realDate) return 0;
    return Math.round((realDate.getTime() - plannedDate.getTime()) / 60000);
  }

  _countdownInfo(value, now = Date.now()) {
    const date = this._asDate(value);
    if (!date) return null;
    const minutes = Math.ceil((date.getTime() - now) / 60000);
    if (minutes < -120) return null;
    if (minutes < 0) return { minutes, status: "departed", label: `vor ${Math.abs(minutes)} Min.` };
    if (minutes === 0) return { minutes, status: "now", label: "jetzt" };
    return { minutes, status: minutes <= 5 ? "soon" : "future", label: `in ${minutes} Min.` };
  }

  _problemInfo(raw) {
    const value = String(raw || "").trim();
    if (!value || ["null", "none"].includes(value.toLowerCase())) return null;
    const lower = value.toLowerCase();
    if (lower.includes("canceled") || lower.includes("cancelled") || lower.includes("fällt aus")) {
      return { kind: "cancelled", label: "Verbindung fällt aus" };
    }
    if (lower.includes("stop_not_applicable") || lower.includes("halt entfällt")) {
      return { kind: "cancelled-stop", label: "Halt entfällt" };
    }
    if (lower.includes("change_not_accessible") || lower.includes("anschluss")) {
      return { kind: "connection", label: "Anschluss gefährdet" };
    }
    if (lower.includes("delay") || lower.includes("verspät")) {
      return { kind: "delay", label: "Starke Verspätung" };
    }
    return { kind: "notice", label: value };
  }

  _platformInfo(step, type) {
    const prefix = type === "arrival" ? "Arrival" : "Departure";
    const snake = type === "arrival" ? "arrival" : "departure";
    const planned = this._attr(step,
      `${prefix} Platform Planned`, `${prefix} Platform`,
      `${snake}_platform_planned`, `${snake}_platform`
    );
    const real = this._attr(step,
      `${prefix} Platform Real`, `${prefix} Platform Actual`,
      `${snake}_platform_real`, `${snake}_platform_actual`
    );
    return { planned, real, changed: Boolean(planned && real && String(planned) !== String(real)) };
  }

  _renderPlatform(step, type, compact = false) {
    const platform = this._platformInfo(step, type);
    if (!platform.planned && !platform.real) return "";
    const prefix = compact ? "Gl." : "Gleis";
    if (platform.changed) {
      return `<small class="platform-change"><s>${prefix} ${this._escape(platform.planned)}</s><strong>${prefix} ${this._escape(platform.real)}</strong></small>`;
    }
    return `<small>${prefix} ${this._escape(platform.real || platform.planned)}</small>`;
  }

  _transferInfo(previous, next) {
    if (!previous || !next) return null;
    const arrival = this._attr(previous, "Arrival Time Real", "Arrival Time", "arrival_time_real", "arrival_time");
    const departure = this._attr(next, "Departure Time Real", "Departure Time", "departure_time_real", "departure_time");
    const arrivalDate = this._asDate(arrival);
    const departureDate = this._asDate(departure);
    if (!arrivalDate || !departureDate) return null;
    const minutes = Math.round((departureDate.getTime() - arrivalDate.getTime()) / 60000);
    if (minutes < 0) return { minutes, status: "missed", label: "Umstieg verpasst" };
    if (minutes <= 2) return { minutes, status: "critical", label: "Umstieg gefährdet" };
    if (minutes <= 5) return { minutes, status: "tight", label: "Umstieg knapp" };
    return { minutes, status: "relaxed", label: "Umstieg entspannt" };
  }

  _journeyTransferRisk(details) {
    const transports = details
      .map((step, index) => ({ step, index, kind: this._transport(this._attr(step, "Name", "name")).kind }))
      .filter((item) => item.kind !== "walk");
    const risks = [];
    for (let index = 0; index < transports.length - 1; index += 1) {
      const info = this._transferInfo(transports[index].step, transports[index + 1].step);
      if (info) risks.push(info);
    }
    const priority = { missed: 4, critical: 3, tight: 2, relaxed: 1 };
    return risks.sort((left, right) => priority[right.status] - priority[left.status])[0] || null;
  }

  _journeyRankings(states) {
    const usable = states.filter((state) => !["cancelled", "cancelled-stop"].includes(this._problemInfo(this._attr(state.attributes, "Problems", "problems"))?.kind));
    const candidates = usable.length ? usable : states;
    const rows = candidates.map((state) => {
      const attr = state.attributes || {};
      const departure = this._asDate(this._attr(attr, "Departure Time Real", "Departure Time", "departure_time_real", "departure_time"));
      const arrival = this._asDate(this._attr(attr, "Arrival Time Real", "Arrival Time", "arrival_time_real", "arrival_time"));
      return {
        state,
        arrival: arrival?.getTime() ?? Infinity,
        duration: departure && arrival ? arrival.getTime() - departure.getTime() : Infinity,
        transfers: Number(this._attr(attr, "Transfers", "transfers") ?? Infinity),
      };
    });
    const minima = {
      arrival: Math.min(...rows.map((row) => row.arrival)),
      duration: Math.min(...rows.map((row) => row.duration)),
      transfers: Math.min(...rows.map((row) => row.transfers)),
    };
    return Object.fromEntries(rows.map((row) => {
      const labels = [];
      if (Number.isFinite(minima.arrival) && row.arrival === minima.arrival) labels.push("Früheste Ankunft");
      if (Number.isFinite(minima.duration) && row.duration === minima.duration) labels.push("Schnellste");
      if (Number.isFinite(minima.transfers) && row.transfers === minima.transfers) labels.push(minima.transfers === 0 ? "Direkt" : "Wenigste Umstiege");
      return [row.state.entity_id, labels];
    }));
  }

  _parseDetails(raw) {
    if (Array.isArray(raw)) return raw.filter((item) => item && typeof item === "object");
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch (_error) {
      try {
        const pythonLike = raw
          .replace(/\bNone\b/g, "null")
          .replace(/\bTrue\b/g, "true")
          .replace(/\bFalse\b/g, "false")
          .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, value) =>
            JSON.stringify(value.replace(/\\'/g, "'"))
          );
        const value = JSON.parse(pythonLike);
        return Array.isArray(value) ? value : [];
      } catch (_ignored) {
        return [];
      }
    }
  }

  _isJourneyState(state) {
    const attr = state?.attributes;
    return Boolean(
      state?.entity_id?.startsWith("sensor.") &&
      this._attr(attr, "Departure Time", "departure_time") &&
      this._attr(attr, "Departure", "departure_station", "origin") &&
      this._attr(attr, "Arrival", "arrival_station", "destination")
    );
  }

  _normalizedRoutes() {
    if (Array.isArray(this._config?.routes) && this._config.routes.length) {
      return this._config.routes.map((route, index) => ({
        max_connections: this._config.max_connections,
        ...route,
        _index: index,
      }));
    }
    return [{
      title: this._config?.route_title,
      entities: this._config?.entities,
      entity_prefix: this._config?.entity_prefix,
      person_entity: this._config?.person_entity,
      home_state: this._config?.home_state,
      home_prefix: this._config?.home_prefix,
      away_prefix: this._config?.away_prefix,
      datetime_entity: this._config?.datetime_entity,
      custom_time_entity: this._config?.custom_time_entity,
      refresh_entity: this._config?.refresh_entity,
      max_connections: this._config?.max_connections,
      _index: 0,
    }];
  }

  _routeKey(route) {
    const entities = Array.isArray(route.entities) ? route.entities.join("|") : route.entities;
    return String(route.id || route.entity_prefix || route.home_prefix || entities || route.title || `route-${route._index}`);
  }

  _activePrefix(route = {}) {
    const personEntity = route.person_entity || this._config?.person_entity;
    const homePrefix = route.home_prefix || this._config?.home_prefix;
    const awayPrefix = route.away_prefix || this._config?.away_prefix;
    const homeState = route.home_state || this._config?.home_state || "home";
    if (personEntity && homePrefix && awayPrefix) {
      const state = this._hass?.states?.[personEntity]?.state;
      return state === homeState ? homePrefix : awayPrefix;
    }
    return route.entity_prefix || homePrefix || "";
  }

  _resolveRouteStates(route) {
    if (!this._hass) return [];
    const max = Math.max(1, Math.min(12, Number(route.max_connections || this._config?.max_connections || 5)));
    const explicit = Array.isArray(route.entities)
      ? route.entities
      : typeof route.entities === "string"
        ? route.entities.split(",").map((item) => item.trim()).filter(Boolean)
        : [];

    let states = [];
    if (explicit.length) {
      states = explicit.map((id) => this._hass.states[id]).filter((state) => this._isJourneyState(state));
    } else {
      const prefix = this._activePrefix(route);
      if (prefix) {
        states = Object.values(this._hass.states).filter(
          (state) => state.entity_id?.startsWith(prefix) && this._isJourneyState(state)
        );
      } else if (this._normalizedRoutes().length === 1) {
        states = Object.values(this._hass.states).filter((state) => this._isJourneyState(state));
      }
    }

    return states.sort((left, right) => {
      const leftTime = this._asDate(this._attr(left.attributes, "Departure Time Real", "Departure Time", "departure_time_real", "departure_time"))?.getTime() || 0;
      const rightTime = this._asDate(this._attr(right.attributes, "Departure Time Real", "Departure Time", "departure_time_real", "departure_time"))?.getTime() || 0;
      return leftTime - rightTime;
    }).slice(0, max);
  }

  _resolveRouteData() {
    return this._normalizedRoutes().map((route) => ({
      route,
      key: this._routeKey(route),
      states: this._resolveRouteStates(route),
    }));
  }

  _transport(name) {
    const original = String(name || "").trim();
    const lower = original.toLowerCase();
    let label = original;
    let kind = "train";

    if (lower === "fußweg" || lower === "fussweg" || lower.includes("walk")) return { kind: "walk", label: "Fußweg" };
    if (lower.includes("sev") || lower.includes("ersatzverkehr")) {
      return { kind: "replacement", label: "SEV" };
    }
    if (lower.includes("metropolexpress") || /(^|\s)mex\s*\d*/i.test(original)) {
      label = original.replace(/metropolexpress\s*/i, "MEX ").replace(/^MEX\s+MEX/i, "MEX").trim();
      kind = "mex";
    } else if (lower.includes("stadtbahn") || lower.includes("u-bahn") || /^u\s?\d+/i.test(original)) {
      label = original.replace(/stadtbahn\s*/i, "").replace(/u-bahn\s*/i, "U").trim();
      kind = "urban";
    } else if (lower.includes("s-bahn") || /^s\s?\d+/i.test(original)) {
      label = original.replace(/s-bahn\s*/i, "S").trim();
      kind = "suburban";
    } else if (lower.includes("bus") || /^x\s?\d+/i.test(original)) {
      label = original.replace(/^bus\s*/i, "Bus ").trim();
      kind = "bus";
    } else if (lower.includes("tram") || lower.includes("straßenbahn")) {
      kind = "tram";
    } else if (/^(ice|ic|ec|re|rb|ire)\b/i.test(original)) {
      kind = /^(re|rb|ire)\b/i.test(original) ? "regional" : "longdistance";
    }
    return { kind, label: label || "Zug" };
  }

  _renderTransfer(details, index) {
    const info = this._transferInfo(details[index - 1], details[index + 1]);
    const label = info ? (info.minutes <= 0 ? "⚡" : `${info.minutes}′`) : "🚶";
    const status = info?.status || "unknown";
    return `<span class="segment transfer ${status}" title="${this._escape(info?.label || "Fußweg und Umstieg")}">${label}</span>`;
  }

  _renderSegments(attributes) {
    let details = this._parseDetails(this._attr(attributes, "Details", "details"));
    if (!details.length) {
      const summary = String(this._attr(attributes, "Name", "name") || "");
      details = summary.split(/\s*->\s*/).filter(Boolean).map((Name) => ({ Name }));
    }
    if (!details.length) return "";

    const problem = this._problemInfo(this._attr(attributes, "Problems", "problems"));
    let problemMarked = false;
    const segments = details.map((step, index) => {
      const transport = this._transport(this._attr(step, "Name", "name"));
      if (transport.kind === "walk") return this._renderTransfer(details, index);
      const titleParts = [
        this._attr(step, "Departure", "departure"),
        this._attr(step, "Arrival", "arrival"),
      ].filter(Boolean);
      const affected = Boolean(problem && !problemMarked);
      if (affected) problemMarked = true;
      const title = affected ? `${problem.label} · ${titleParts.join(" → ")}` : titleParts.join(" → ");
      return `<span class="segment ${transport.kind} ${affected ? "affected" : ""}" title="${this._escape(title)}">${this._escape(transport.label)}</span>`;
    }).join("");
    return `<div class="segments">${segments}</div>`;
  }

  _renderTime(planned, real, type) {
    const delay = this._delayMinutes(planned, real);
    const plannedText = this._formatTime(planned);
    const realText = this._formatTime(real || planned);
    const changed = Boolean(real && realText !== plannedText);
    return `<div class="time ${delay > 0 ? "delayed" : delay < 0 ? "early" : "ontime"}">
      <span class="time-label">${type}</span>
      ${changed ? `<span class="planned">${this._escape(plannedText)}</span>` : ""}
      <strong>${this._escape(realText)}</strong>
      ${delay > 0 ? `<span class="delay">+${delay}</span>` : ""}
    </div>`;
  }

  _routeBase(route, states) {
    const prefix = this._activePrefix(route) || states?.[0]?.entity_id || "";
    return String(prefix)
      .replace(/^sensor\./, "")
      .replace(/_verbindung_\d+$/i, "")
      .replace(/_verbindung_$/i, "");
  }

  _findControlEntity(route, states, property, domain, suffixes, friendlyTerms) {
    if (route[property]) return route[property];
    const base = this._routeBase(route, states);
    const candidates = suffixes.map((suffix) => `${domain}.${base}${suffix}`);
    const exact = candidates.find((entityId) => this._hass?.states?.[entityId]);
    if (exact) return exact;

    const terms = friendlyTerms.map((term) => term.toLowerCase());
    return Object.entries(this._hass?.states || {}).find(([entityId, state]) => {
      if (!entityId.startsWith(`${domain}.${base}`)) return false;
      const name = String(state.attributes?.friendly_name || "").toLowerCase();
      return terms.some((term) => name.includes(term));
    })?.[0] || "";
  }

  _routeControls(route, states) {
    return {
      datetime: this._findControlEntity(
        route, states, "datetime_entity", "datetime",
        ["_abfahrtszeit", "_departure_time"], ["abfahrtszeit", "departure time"]
      ),
      customTime: this._findControlEntity(
        route, states, "custom_time_entity", "switch",
        ["_benutzerdefinierte_zeit_verwenden", "_custom_time"], ["benutzerdefinierte zeit", "custom time"]
      ),
      refresh: this._findControlEntity(
        route, states, "refresh_entity", "button",
        ["_refresh", "_aktualisieren"], ["refresh", "aktualisieren"]
      ),
    };
  }

  _formatDateTimeLocal(value) {
    const date = this._asDate(value) || new Date();
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  _formatServiceDateTime(date) {
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  _navigationTarget(routeData, direction) {
    const { key, route, states } = routeData;
    const controls = this._routeControls(route, states);
    const history = this._navigationHistory[key] || [];
    const customEnabled = this._hass?.states?.[controls.customTime]?.state === "on";
    const currentCustom = customEnabled ? this._asDate(this._hass?.states?.[controls.datetime]?.state) : null;
    const departures = states
      .map((state) => this._asDate(this._attr(state.attributes, "Departure Time", "departure_time")))
      .filter(Boolean)
      .sort((left, right) => left - right);

    if (direction === "earlier" && history.length) return history.pop();
    if (direction === "later") {
      const currentAnchor = currentCustom || departures[0] || new Date();
      history.push(currentAnchor);
      this._navigationHistory[key] = history.slice(-10);
      const lastDeparture = departures.at(-1) || currentAnchor;
      return new Date(lastDeparture.getTime() + 60000);
    }

    const step = Math.max(5, Number(route.navigation_step_minutes || this._config.navigation_step_minutes || 60));
    const anchor = currentCustom || departures[0] || new Date();
    return new Date(anchor.getTime() - step * 60000);
  }

  async _setRouteTime(routeData, date) {
    const { key, route, states } = routeData;
    const controls = this._routeControls(route, states);
    if (!controls.datetime || !controls.customTime) {
      this._notify("Für diese Strecke fehlen datetime_entity und custom_time_entity der DB-Info-Integration.");
      return;
    }

    this._loadingRoutes[key] = true;
    this._lastSignature = "";
    this._render();
    try {
      await this._hass.callService("datetime", "set_value", {
        entity_id: controls.datetime,
        datetime: this._formatServiceDateTime(date),
      });
      if (this._hass.states?.[controls.customTime]?.state !== "on") {
        await this._hass.callService("switch", "turn_on", { entity_id: controls.customTime });
      } else if (controls.refresh) {
        await this._hass.callService("button", "press", { entity_id: controls.refresh });
      } else {
        await this._hass.callService("db_info", "refresh_all", {});
      }
    } catch (error) {
      console.error("DB Navigator navigation failed", error);
      this._notify(`Verbindungen konnten nicht geladen werden: ${error?.message || error}`);
    } finally {
      this._loadingRoutes[key] = false;
      this._lastSignature = "";
      this._render();
    }
  }

  async _resetRouteTime(routeData) {
    const { key, route, states } = routeData;
    const controls = this._routeControls(route, states);
    if (!controls.customTime) {
      this._notify("Für diese Strecke wurde kein Schalter für die benutzerdefinierte Zeit gefunden.");
      return;
    }
    this._navigationHistory[key] = [];
    this._loadingRoutes[key] = true;
    this._lastSignature = "";
    this._render();
    try {
      await this._hass.callService("switch", "turn_off", { entity_id: controls.customTime });
    } finally {
      this._loadingRoutes[key] = false;
      this._lastSignature = "";
      this._render();
    }
  }

  _notify(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", {
      bubbles: true,
      composed: true,
      detail: { message },
    }));
  }

  _renderRouteControls(routeData) {
    const { key, route, states } = routeData;
    const controls = this._routeControls(route, states);
    const available = Boolean(controls.datetime && controls.customTime);
    const loading = Boolean(this._loadingRoutes[key]);
    const customEnabled = this._hass?.states?.[controls.customTime]?.state === "on";
    const selectedTime = this._hass?.states?.[controls.datetime]?.state;
    const disabled = !available || loading ? "disabled" : "";
    const picker = (route.show_time_picker ?? this._config.show_time_picker) === false ? "" : `
      <div class="time-picker">
        <input type="datetime-local" data-time-input="${this._escape(key)}" value="${this._formatDateTimeLocal(selectedTime)}" ${disabled} aria-label="Eigene Abfahrtszeit">
        <button class="search-time" data-route-action="search" data-route-key="${this._escape(key)}" ${disabled}>Suchen</button>
      </div>`;

    return `<div class="navigation ${customEnabled ? "custom-active" : ""}">
      <div class="nav-buttons">
        <button data-route-action="earlier" data-route-key="${this._escape(key)}" ${disabled}><ha-icon icon="mdi:chevron-left"></ha-icon>Früher</button>
        <button class="now-button" data-route-action="now" data-route-key="${this._escape(key)}" ${disabled}>${loading ? "Lädt …" : "Jetzt"}</button>
        <button data-route-action="later" data-route-key="${this._escape(key)}" ${disabled}>Später<ha-icon icon="mdi:chevron-right"></ha-icon></button>
      </div>
      ${picker}
      ${available ? "" : `<div class="control-hint">Zeitsteuerung nicht automatisch gefunden. Optional <code>datetime_entity</code> und <code>custom_time_entity</code> für diese Strecke angeben.</div>`}
    </div>`;
  }

  _renderRoutePreview(state, departureTime) {
    if (!state) return "";
    const attr = state.attributes || {};
    let steps = this._parseDetails(this._attr(attr, "Details", "details"));
    if (!steps.length) {
      steps = String(this._attr(attr, "Name", "name") || "")
        .split(/\s*->\s*/)
        .filter(Boolean)
        .map((Name) => ({ Name }));
    }
    const products = [];
    for (const step of steps) {
      const product = this._transport(this._attr(step, "Name", "name"));
      if (product.kind === "walk") continue;
      const token = `${product.kind}:${product.label}`;
      if (!products.some((item) => item.token === token)) products.push({ ...product, token });
    }
    const visible = products.slice(0, 2);
    const countdown = this._countdownInfo(departureTime);
    return `<span class="route-next">
      <span class="route-next-time"><small>${this._escape(countdown?.label || "Abfahrt")}</small><strong>${this._escape(this._formatTime(departureTime))}</strong></span>
      <span class="route-next-products">${visible.map((product) => `<b class="mini-product ${product.kind}">${this._escape(product.label)}</b>`).join("")}${products.length > 2 ? `<em>+${products.length - 2}</em>` : ""}</span>
    </span>`;
  }

  _renderRouteSection(routeData, index) {
    const { key, route, states } = routeData;
    const first = states[0];
    const departure = this._attr(first?.attributes, "Departure", "departure_station", "origin") || "Start";
    const arrival = this._attr(first?.attributes, "Arrival", "arrival_station", "destination") || "Ziel";
    const title = route.title || `${departure} → ${arrival}`;
    const firstDeparture = this._attr(first?.attributes, "Departure Time Real", "Departure Time", "departure_time_real", "departure_time");
    const preview = this._renderRoutePreview(first, firstDeparture);
    const isOpen = this._expandedRoutes[key] ?? route.open ?? index === 0;
    const rankings = this._journeyRankings(states);
    const journeys = states.length
      ? `<div class="list">${states.map((state) => this._renderJourney(state, rankings[state.entity_id] || [])).join("")}</div>`
      : `<div class="empty"><ha-icon icon="mdi:train-off"></ha-icon>Keine Verbindungen für diese Strecke gefunden.<code>${this._escape(this._activePrefix(route) || (route.entities || []).join?.(", ") || "Keine Entities konfiguriert")}</code></div>`;

    return `<section class="route-section ${isOpen ? "open" : ""}">
      <button class="route-header" data-toggle-route="${this._escape(key)}" aria-expanded="${isOpen}">
        <span class="route-symbol"><ha-icon icon="mdi:train"></ha-icon></span>
        <span class="route-heading"><strong>${this._escape(title)}</strong><small>${states.length} ${states.length === 1 ? "Verbindung" : "Verbindungen"}</small></span>
        ${preview}
        <ha-icon class="route-chevron" icon="mdi:chevron-down"></ha-icon>
      </button>
      <div class="route-collapse"><div class="route-content">${journeys}${this._renderRouteControls(routeData)}</div></div>
    </section>`;
  }

  _renderStopTime(planned, real) {
    const plannedText = this._formatTime(planned);
    const realText = this._formatTime(real || planned);
    const delay = this._delayMinutes(planned, real);
    const changed = Boolean(real && plannedText !== realText);
    return `<span class="stop-time ${delay > 0 ? "late" : "punctual"}">
      ${changed ? `<s>${this._escape(plannedText)}</s>` : ""}
      <b>${this._escape(realText)}</b>
      ${delay > 0 ? `<em>+${delay}</em>` : ""}
    </span>`;
  }

  _renderJourneyDetails(state) {
    const attr = state.attributes || {};
    const details = this._parseDetails(this._attr(attr, "Details", "details"));
    const problem = this._problemInfo(this._attr(attr, "Problems", "problems"));

    const legs = details.length ? details.map((step, index) => {
      const transport = this._transport(this._attr(step, "Name", "name"));
      if (transport.kind === "walk") {
        const transfer = this._renderTransfer(details, index);
        const risk = this._transferInfo(details[index - 1], details[index + 1]);
        const riskText = risk ? `${risk.label} · ${Math.max(0, risk.minutes)} Min.` : "Fußweg und Umstieg";
        return `<div class="walk-detail ${risk?.status || "unknown"}"><span class="walk-icon">${transfer}</span><span>${this._escape(riskText)}</span></div>`;
      }

      const departure = this._attr(step, "Departure", "departure") || "Abfahrt";
      const arrival = this._attr(step, "Arrival", "arrival") || "Ankunft";
      const depPlanned = this._attr(step, "Departure Time", "departure_time");
      const depReal = this._attr(step, "Departure Time Real", "departure_time_real");
      const arrPlanned = this._attr(step, "Arrival Time", "arrival_time");
      const arrReal = this._attr(step, "Arrival Time Real", "arrival_time_real");

      return `<div class="leg">
        <div class="stop-row">
          <span class="stop-marker start"></span>
          <span class="stop-kind">Ab</span>
          <span class="stop-product ${transport.kind}">${this._escape(transport.label)}</span>
          <span class="stop-main"><b>${this._escape(departure)}</b>${this._renderPlatform(step, "departure")}</span>
          ${this._renderStopTime(depPlanned, depReal)}
        </div>
        <div class="leg-line"></div>
        <div class="stop-row">
          <span class="stop-marker end"></span>
          <span class="stop-kind">An</span>
          <span class="stop-product ${transport.kind}">${this._escape(transport.label)}</span>
          <span class="stop-main"><b>${this._escape(arrival)}</b>${this._renderPlatform(step, "arrival")}</span>
          ${this._renderStopTime(arrPlanned, arrReal)}
        </div>
      </div>`;
    }).join("") : `<div class="detail-empty">Keine einzelnen Fahrtabschnitte in <code>Details</code> vorhanden.</div>`;

    return `<div class="journey-detail-inner">
      <div class="detail-title"><span>Reiseverlauf</span><button data-more-info="${this._escape(state.entity_id)}" title="Home-Assistant-Entität öffnen"><ha-icon icon="mdi:information-outline"></ha-icon></button></div>
      ${problem ? `<div class="detail-problem ${problem.kind}"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><strong>${this._escape(problem.label)}</strong></div>` : ""}
      <div class="legs">${legs}</div>
    </div>`;
  }

  _renderJourney(state, rankings = []) {
    const attr = state.attributes || {};
    const depPlanned = this._attr(attr, "Departure Time", "departure_time");
    const depReal = this._attr(attr, "Departure Time Real", "departure_time_real");
    const arrPlanned = this._attr(attr, "Arrival Time", "arrival_time");
    const arrReal = this._attr(attr, "Arrival Time Real", "arrival_time_real");
    const departure = this._attr(attr, "Departure", "departure_station", "origin") || "Start";
    const arrival = this._attr(attr, "Arrival", "arrival_station", "destination") || "Ziel";
    const duration = this._attr(attr, "Duration", "duration") || "";
    const transfers = this._attr(attr, "Transfers", "transfers");
    const problem = this._problemInfo(this._attr(attr, "Problems", "problems"));
    const details = this._parseDetails(this._attr(attr, "Details", "details"));
    const first = details.find((step) => this._transport(this._attr(step, "Name", "name")).kind !== "walk") || {};
    const last = [...details].reverse().find((step) => this._transport(this._attr(step, "Name", "name")).kind !== "walk") || {};
    const transferText = transfers !== null && transfers !== undefined
      ? `${transfers} ${Number(transfers) === 1 ? "Umstieg" : "Umstiege"}`
      : "";
    const isExpanded = Boolean(this._expandedJourneys[state.entity_id]);
    const countdown = this._countdownInfo(depReal || depPlanned);
    const transferRisk = this._journeyTransferRisk(details);

    return `<article class="journey ${isExpanded ? "expanded" : ""} ${problem ? `has-problem ${problem.kind}` : ""}" data-entity="${this._escape(state.entity_id)}">
      <div class="journey-summary" data-toggle-journey="${this._escape(state.entity_id)}" tabindex="0" role="button" aria-expanded="${isExpanded}" aria-label="Details der Verbindung ${this._escape(departure)} nach ${this._escape(arrival)} ${isExpanded ? "schließen" : "öffnen"}">
      <div class="journey-badges">${rankings.map((label) => `<span>${this._escape(label)}</span>`).join("")}${transferRisk ? `<span class="transfer-risk ${transferRisk.status}">${this._escape(transferRisk.label)}</span>` : ""}</div>
      <div class="journey-top">
        <div class="times">
          ${this._renderTime(depPlanned, depReal, "Ab")}
          <span class="time-divider">–</span>
          ${this._renderTime(arrPlanned, arrReal, "An")}
        </div>
        <div class="meta">${countdown ? `<span class="countdown ${countdown.status}">${this._escape(countdown.label)}</span>` : ""}${[duration, transferText].filter(Boolean).map((value) => `<span>${this._escape(value)}</span>`).join("")}</div>
      </div>
      ${this._renderSegments(attr)}
      ${this._config.show_route === false ? "" : `<div class="route">
        <div><span class="dot start"></span><span>${this._escape(departure)}</span>${this._config.show_platforms !== false ? this._renderPlatform(first, "departure", true) : ""}</div>
        <div><span class="dot end"></span><span>${this._escape(arrival)}</span>${this._config.show_platforms !== false ? this._renderPlatform(last, "arrival", true) : ""}</div>
      </div>`}
      ${problem ? `<div class="problem ${problem.kind}"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><strong>${this._escape(problem.label)}</strong></div>` : ""}
      <div class="expand-label"><span>${isExpanded ? "Details schließen" : "Fahrt anzeigen"}</span><ha-icon icon="mdi:chevron-down"></ha-icon></div>
      </div>
      <div class="journey-detail-collapse"><div class="journey-detail">${this._renderJourneyDetails(state)}</div></div>
    </article>`;
  }

  _styles() {
    return `
      :host { display:block; --db-red:#ec0016; font-family:var(--paper-font-body1_-_font-family, -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif); }
      * { box-sizing:border-box; }
      ha-card { --db-surface:var(--secondary-background-color, #f4f5f6); --db-panel:var(--card-background-color, #fff); --db-text:var(--primary-text-color, #282d37); --db-muted:var(--secondary-text-color, #69717c); --db-divider:var(--divider-color, #e4e6e8); overflow:hidden; border-radius:16px; background:var(--db-surface); color:var(--db-text); border:0; box-shadow:var(--ha-card-box-shadow, 0 4px 14px rgba(0,0,0,.10)); }
      ha-card.theme-light { --db-surface:#f3f4f6; --db-panel:#fff; --db-text:#20242a; --db-muted:#69717c; --db-divider:#e0e3e7; color-scheme:light; }
      ha-card.theme-dark { --db-surface:#20242a; --db-panel:#30353d; --db-text:#f5f6f7; --db-muted:#b0b6bf; --db-divider:#484e57; color-scheme:dark; }
      .db-stripe { height:5px; background:var(--db-red); }
      .content { padding:14px; }
      .header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:0 2px 12px; }
      .brand { display:flex; gap:10px; align-items:center; min-width:0; }
      .db-logo { display:grid; place-items:center; flex:0 0 auto; width:34px; height:24px; border:2px solid var(--db-red); border-radius:3px; color:var(--db-red); background:#fff; font-size:14px; font-weight:900; letter-spacing:-1px; }
      .heading { min-width:0; }
      .title { font-size:13px; font-weight:750; color:var(--secondary-text-color, #5f6670); }
      .headline { display:flex; align-items:center; gap:6px; margin-top:2px; min-width:0; font-size:16px; font-weight:800; color:var(--primary-text-color, #1f2329); }
      .headline span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .headline ha-icon { flex:0 0 auto; --mdc-icon-size:17px; color:#878d96; }
      .count { flex:0 0 auto; padding:4px 8px; border-radius:999px; background:var(--db-panel); color:var(--db-muted); font-size:10px; font-weight:800; box-shadow:0 1px 4px rgba(0,0,0,.06); }
      .routes { display:flex; flex-direction:column; gap:10px; }
      .route-section { overflow:hidden; border-radius:13px; background:var(--db-panel); box-shadow:0 2px 8px rgba(20,24,30,.08); }
      .route-header { display:grid; grid-template-columns:34px minmax(0,1fr) auto 24px; align-items:center; gap:10px; width:100%; padding:12px 13px; border:0; background:transparent; color:var(--db-text); text-align:left; cursor:pointer; }
      .route-header:hover { background:color-mix(in srgb, var(--primary-text-color, #282d37) 4%, transparent); }
      .route-symbol { display:grid; place-items:center; width:32px; height:32px; border-radius:50%; background:#ec0016; color:#fff; }
      .route-symbol ha-icon { --mdc-icon-size:19px; }
      .route-heading { display:flex; flex-direction:column; min-width:0; gap:3px; }
      .route-heading strong { overflow:hidden; font-size:14px; text-overflow:ellipsis; white-space:nowrap; }
      .route-heading small { color:var(--db-muted); font-size:10px; }
      .route-next { display:flex; align-items:center; justify-content:flex-end; gap:9px; min-width:0; }
      .route-section.open .route-next { display:none; }
      .route-next-time { display:flex; flex-direction:column; align-items:flex-end; line-height:1; }
      .route-next-time small { margin-bottom:3px; color:var(--db-muted); font-size:8px; font-weight:750; text-transform:uppercase; }
      .route-next-time strong { color:var(--db-text); font-size:16px; font-variant-numeric:tabular-nums; }
      .route-next-products { display:flex; align-items:center; justify-content:flex-end; gap:3px; max-width:128px; overflow:hidden; }
      .mini-product { display:block; max-width:72px; overflow:hidden; padding:4px 6px; border-radius:4px; background:#282d37; color:#fff; font-size:9px; font-weight:850; text-overflow:ellipsis; white-space:nowrap; }
      .mini-product.suburban { background:#178447; } .mini-product.urban { background:#005ca9; } .mini-product.bus { background:#7b2d75; } .mini-product.tram { background:#c86200; } .mini-product.mex { background:#f5c400; color:#20242a; } .mini-product.regional { background:#5c626b; } .mini-product.longdistance { background:#ec0016; } .mini-product.replacement { background:#8a3ffc; }
      .route-next-products em { color:var(--db-muted); font-size:8px; font-style:normal; font-weight:800; }
      .route-chevron { --mdc-icon-size:22px; color:var(--db-muted); transition:transform .22s ease; }
      .route-section.open .route-chevron { transform:rotate(180deg); }
      .route-collapse { display:grid; grid-template-rows:0fr; transition:grid-template-rows .25s ease; }
      .route-section.open .route-collapse { grid-template-rows:1fr; }
      .route-content { min-height:0; overflow:hidden; }
      .route-content > .list, .route-content > .empty { margin:0 10px; }
      .route-content > .list { padding-top:2px; }
      .list { display:flex; flex-direction:column; gap:9px; }
      .route-content .journey { border:1px solid var(--db-divider); box-shadow:none; }
      .navigation { margin:10px; padding:10px; border-radius:10px; background:var(--db-surface); }
      .nav-buttons { display:grid; grid-template-columns:1fr auto 1fr; gap:7px; }
      .nav-buttons button, .search-time { display:flex; align-items:center; justify-content:center; gap:3px; min-height:36px; border:1px solid var(--divider-color, #d7d9dc); border-radius:8px; background:var(--db-panel); color:var(--db-text); font-size:11px; font-weight:800; cursor:pointer; }
      .nav-buttons button:hover, .search-time:hover { border-color:#ec0016; color:#ec0016; }
      .nav-buttons button:disabled, .search-time:disabled { opacity:.42; cursor:not-allowed; }
      .nav-buttons ha-icon { --mdc-icon-size:18px; }
      .now-button { min-width:68px; border-color:#ec0016 !important; color:#ec0016 !important; }
      .custom-active .now-button::before { content:""; width:6px; height:6px; border-radius:50%; background:#ec0016; }
      .time-picker { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; margin-top:8px; }
      .time-picker input { min-width:0; min-height:36px; padding:5px 8px; border:1px solid var(--divider-color, #d7d9dc); border-radius:8px; background:var(--db-panel); color:var(--db-text); font:inherit; font-size:11px; }
      .search-time { padding:0 13px; background:#ec0016; border-color:#ec0016; color:#fff; }
      .search-time:hover { background:#c90018; color:#fff; }
      .control-hint { margin-top:7px; color:var(--secondary-text-color, #69717c); font-size:9px; line-height:1.35; }
      .control-hint code { color:inherit; }

      .journey { background:var(--db-panel); border-radius:12px; padding:13px 14px; box-shadow:0 2px 7px rgba(20,24,30,.07); cursor:pointer; outline:none; transition:transform .14s ease, box-shadow .14s ease; }
      .journey:hover, .journey:focus-visible { transform:translateY(-1px); box-shadow:0 5px 14px rgba(20,24,30,.12); }
      .journey:focus-visible { box-shadow:0 0 0 2px var(--db-red), 0 5px 14px rgba(20,24,30,.12); }
      .journey.cancelled { background:color-mix(in srgb, var(--db-panel) 92%, #ec0016); }
      .journey-badges { display:flex; flex-wrap:wrap; gap:4px; margin:0 0 7px; }
      .journey-badges:empty { display:none; }
      .journey-badges > span { padding:3px 6px; border-radius:999px; background:#e3f2e8; color:#087832; font-size:8px; font-weight:850; }
      .journey-badges .transfer-risk.relaxed { background:#e3f2e8; color:#087832; }
      .journey-badges .transfer-risk.tight { background:#fff0d6; color:#8a5300; }
      .journey-badges .transfer-risk.critical, .journey-badges .transfer-risk.missed { background:#fde1e4; color:#c90018; }
      .journey-top { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
      .times { display:flex; align-items:flex-end; gap:7px; min-width:0; }
      .time { display:grid; grid-template-columns:auto auto; align-items:baseline; column-gap:4px; line-height:1; }
      .time-label { grid-column:1/-1; margin-bottom:3px; font-size:9px; font-weight:800; color:#848a94; text-transform:uppercase; letter-spacing:.5px; }
      .time strong { font-size:18px; font-variant-numeric:tabular-nums; color:var(--db-text); }
      .time.ontime strong, .time.early strong { color:#138a42; }
      .time.delayed strong, .time.delayed .delay { color:#d20a1e; }
      .planned { font-size:11px; color:#777f89; text-decoration:line-through; font-variant-numeric:tabular-nums; }
      .delay { font-size:10px; font-weight:900; }
      .time-divider { padding-bottom:2px; color:#9ba0a8; font-weight:500; }
      .meta { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:4px; color:#6d747e; font-size:11px; font-weight:650; }
      .meta span + span::before { content:"•"; margin-right:4px; color:#b0b4bb; }
      .meta .countdown { padding:3px 6px; border-radius:999px; background:var(--db-surface); color:var(--db-text); font-size:9px; font-weight:850; }
      .meta .countdown.soon, .meta .countdown.now { background:#fde1e4; color:#c90018; }
      .meta .countdown.departed { color:var(--db-muted); }
      .segments { display:flex; align-items:stretch; gap:3px; margin:10px 0 9px; min-height:28px; }
      .segment { display:flex; align-items:center; justify-content:center; min-width:42px; flex:1 1 0; overflow:hidden; padding:6px 7px; border-radius:5px; background:#282d37; color:#fff; font-size:11px; font-weight:850; letter-spacing:.15px; text-overflow:ellipsis; white-space:nowrap; }
      .segment.transfer { flex:0 0 auto; min-width:28px; background:#e7e9ec; color:#59616c; }
      .segment.transfer.relaxed { background:#e3f2e8; color:#087832; }
      .segment.transfer.tight { background:#fff0d6; color:#8a5300; }
      .segment.transfer.critical, .segment.transfer.missed { background:#fde1e4; color:#c90018; }
      .segment.suburban { background:#178447; }
      .segment.urban { background:#005ca9; }
      .segment.bus { background:#7b2d75; }
      .segment.tram { background:#c86200; }
      .segment.mex { background:#f5c400; color:#20242a; }
      .segment.regional { background:#5c626b; }
      .segment.longdistance { background:#ec0016; }
      .segment.replacement { background:#8a3ffc; }
      .segment.affected { position:relative; padding-right:20px; outline:2px solid #f4a100; outline-offset:-2px; }
      .segment.affected::after { content:"!"; position:absolute; right:5px; display:grid; place-items:center; width:13px; height:13px; border-radius:50%; background:#fff; color:#c90018; font-size:9px; font-weight:950; }
      .route { position:relative; display:grid; gap:5px; color:var(--db-muted); font-size:11px; }
      .route::before { content:""; position:absolute; left:4px; top:6px; bottom:6px; width:1px; background:#b8bdc4; }
      .route > div { position:relative; display:grid; grid-template-columns:10px minmax(0,1fr) auto; align-items:center; gap:7px; min-width:0; }
      .route > div > span:nth-child(2) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dot { z-index:1; width:9px; height:9px; border:2px solid #727983; border-radius:50%; background:var(--db-panel); }
      .dot.end { background:#727983; }
      .route small { color:#7d848d; font-size:10px; font-weight:700; }
      .platform-change { display:flex; align-items:center; gap:4px; }
      .platform-change s { color:var(--db-muted); font-weight:500; }
      .platform-change strong { color:#c90018; }
      .problem { display:flex; align-items:flex-start; gap:5px; margin-top:9px; padding:7px 8px; border-radius:7px; background:#fff0d6; color:#7a4c00; font-size:10px; line-height:1.3; }
      .problem.cancelled, .problem.cancelled-stop, .detail-problem.cancelled, .detail-problem.cancelled-stop { background:#fde1e4; color:#a90015; }
      .problem.connection, .detail-problem.connection { background:#fff0d6; color:#7a4c00; }
      .problem ha-icon { --mdc-icon-size:15px; flex:0 0 auto; }
      .expand-label { display:flex; align-items:center; justify-content:flex-end; gap:2px; margin-top:8px; color:var(--db-muted); font-size:9px; font-weight:750; }
      .expand-label ha-icon { --mdc-icon-size:17px; transition:transform .22s ease; }
      .journey.expanded .expand-label ha-icon { transform:rotate(180deg); }
      .journey-detail-collapse { display:grid; grid-template-rows:0fr; transition:grid-template-rows .28s ease; }
      .journey.expanded .journey-detail-collapse { grid-template-rows:1fr; }
      .journey-detail { min-height:0; overflow:hidden; }
      .journey-detail-inner { margin:12px -10px -9px; padding:13px 10px 5px; border-top:1px solid var(--db-divider); }
      .detail-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:9px; color:var(--db-text); font-size:12px; font-weight:850; }
      .detail-title button { display:grid; place-items:center; width:28px; height:28px; border:0; border-radius:50%; background:var(--db-surface); color:var(--db-muted); cursor:pointer; }
      .detail-title button ha-icon { --mdc-icon-size:18px; }
      .detail-problem { display:flex; gap:6px; margin-bottom:11px; padding:8px; border-radius:7px; background:#fff0d6; color:#7a4c00; font-size:10px; line-height:1.35; }
      .detail-problem ha-icon { flex:0 0 auto; --mdc-icon-size:16px; }
      .legs { position:relative; display:flex; flex-direction:column; }
      .legs::before { content:""; position:absolute; z-index:0; left:4px; top:5px; bottom:5px; width:2px; background:#8b929b; }
      .leg { position:relative; z-index:1; padding:0 0 13px; }
      .leg:last-child { padding-bottom:2px; }
      .stop-row { position:relative; display:grid; grid-template-columns:12px 20px minmax(34px,auto) minmax(0,1fr) auto; align-items:start; gap:6px; min-width:0; }
      .stop-product { display:block; max-width:82px; overflow:hidden; padding:3px 6px; border-radius:4px; background:#282d37; color:#fff; font-size:9px; font-weight:850; line-height:1.2; text-align:center; text-overflow:ellipsis; white-space:nowrap; }
      .stop-product.suburban { background:#178447; } .stop-product.urban { background:#005ca9; } .stop-product.bus { background:#7b2d75; } .stop-product.tram { background:#c86200; } .stop-product.mex { background:#f5c400; color:#20242a; } .stop-product.regional { background:#5c626b; } .stop-product.longdistance { background:#ec0016; } .stop-product.replacement { background:#8a3ffc; }
      .stop-marker { z-index:2; width:10px; height:10px; margin-top:3px; border:2px solid #555d67; border-radius:50%; background:var(--db-panel); }
      .stop-marker.end { background:#555d67; }
      .leg:last-of-type .stop-row:last-child::after { content:""; position:absolute; z-index:1; left:2px; top:8px; bottom:-12px; width:6px; background:var(--db-panel); }
      .stop-kind { padding-top:2px; color:var(--db-muted); font-size:8px; font-weight:850; text-transform:uppercase; }
      .stop-main { display:flex; flex-direction:column; min-width:0; gap:2px; }
      .stop-main b { overflow:hidden; color:var(--db-text); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
      .stop-main small { color:var(--db-muted); font-size:9px; }
      .leg-line { height:19px; margin-left:4px; border-left:2px solid #8b929b; }
      .stop-time { display:flex; align-items:baseline; justify-content:flex-end; gap:4px; padding-top:1px; font-variant-numeric:tabular-nums; }
      .stop-time s { color:var(--db-muted); font-size:9px; }
      .stop-time b { color:#138a42; font-size:11px; }
      .stop-time.late b, .stop-time.late em { color:#d20a1e; }
      .stop-time em { font-size:8px; font-style:normal; font-weight:850; }
      .walk-detail { position:relative; z-index:2; display:flex; align-items:center; gap:8px; min-height:36px; margin:-4px 0 9px; padding-left:24px; color:var(--db-muted); font-size:10px; }
      .walk-detail::before { content:""; position:absolute; left:2px; top:-7px; bottom:-7px; width:6px; background:var(--db-panel); }
      .walk-detail::after { content:""; position:absolute; left:4px; top:-7px; bottom:-7px; border-left:2px dashed #8b929b; }
      .walk-detail .segment { position:relative; z-index:1; min-height:24px; flex:0 0 auto; }
      .walk-detail.relaxed { color:#087832; } .walk-detail.tight { color:#8a5300; } .walk-detail.critical, .walk-detail.missed { color:#c90018; font-weight:750; }
      ha-card.density-compact .content { padding:9px; }
      ha-card.density-compact .header { padding-bottom:8px; }
      ha-card.density-compact .routes, ha-card.density-compact .list { gap:5px; }
      ha-card.density-compact .route-header { padding:8px 10px; }
      ha-card.density-compact .journey { padding:8px 9px; border-radius:9px; }
      ha-card.density-compact .journey-badges { margin-bottom:5px; }
      ha-card.density-compact .segments { min-height:22px; margin:6px 0; }
      ha-card.density-compact .segment { padding:4px 5px; font-size:9px; }
      ha-card.density-compact .route { gap:2px; font-size:10px; }
      ha-card.density-compact .problem { margin-top:6px; padding:5px 6px; }
      ha-card.density-compact .expand-label { margin-top:4px; }
      ha-card.density-compact .expand-label span { display:none; }
      ha-card.density-compact .journey-detail-inner { margin-top:7px; padding-top:9px; }
      .detail-empty { padding:8px; color:var(--db-muted); font-size:10px; }
      .empty { padding:22px 14px; border-radius:12px; background:var(--db-panel); color:var(--db-muted); text-align:center; font-size:12px; line-height:1.45; }
      .empty ha-icon { display:block; margin:0 auto 8px; --mdc-icon-size:30px; color:#a2a7ae; }
      .empty code { display:block; margin-top:6px; color:#343a42; word-break:break-all; }
      @media (max-width:420px) {
        .content { padding:11px; }
        .journey { padding:12px 11px; }
        .header { padding-bottom:10px; }
        .headline { font-size:14px; }
        .route-header { grid-template-columns:30px minmax(64px,1fr) auto 20px; gap:6px; padding:10px 8px; }
        .route-symbol { width:28px; height:28px; }
        .route-next { gap:6px; }
        .route-next-time strong { font-size:14px; }
        .route-next-products { max-width:62px; }
        .route-next-products .mini-product:nth-of-type(n+2) { display:none; }
        .mini-product { max-width:58px; padding:4px 5px; }
        .stop-row { grid-template-columns:12px 18px minmax(30px,auto) minmax(0,1fr) auto; gap:4px; }
        .stop-product { max-width:55px; padding:3px 4px; font-size:8px; }
        .stop-time { gap:2px; }
        .time strong { font-size:16px; }
        .meta { font-size:10px; }
        .segment { min-width:30px; padding:6px 4px; font-size:10px; }
      }
    `;
  }

  _signature(routeData) {
    const configSignature = JSON.stringify(this._config || {});
    const stateSignature = routeData.flatMap(({ route, states }) => {
      const controls = this._routeControls(route, states);
      const controlStates = Object.values(controls).map((entityId) => {
        const state = this._hass?.states?.[entityId];
        return `${entityId}:${state?.state}:${state?.last_updated}`;
      });
      return [
        ...states.map((state) => `${state.entity_id}:${state.last_updated}:${state.state}`),
        ...controlStates,
      ];
    }).join("|");
    const uiSignature = JSON.stringify({ routes: this._expandedRoutes, journeys: this._expandedJourneys, loading: this._loadingRoutes });
    return `${configSignature}|${stateSignature}|${uiSignature}`;
  }

  _render() {
    if (!this.shadowRoot || !this._config || !this._hass) return;
    const routeData = this._resolveRouteData();
    const signature = this._signature(routeData);
    if (signature === this._lastSignature) return;
    this._lastSignature = signature;

    const totalConnections = routeData.reduce((sum, item) => sum + item.states.length, 0);
    const header = this._config.show_header === false ? "" : `<div class="header">
      <div class="brand">
        <span class="db-logo" aria-label="DB">DB</span>
        <div class="heading">
          <div class="title">DB Navigator</div>
          <div class="headline"><span>${this._escape(this._config.title)}</span></div>
        </div>
      </div>
      <span class="count">${routeData.length} ${routeData.length === 1 ? "Strecke" : "Strecken"} · ${totalConnections} Fahrten</span>
    </div>`;

    const body = `<div class="routes">${routeData.map((item, index) => this._renderRouteSection(item, index)).join("")}</div>`;
    const appearance = ["light", "dark"].includes(this._config.appearance) ? this._config.appearance : "auto";
    const density = this._config.density === "compact" ? "compact" : "comfortable";
    this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card class="theme-${appearance} density-${density}"><div class="db-stripe"></div><div class="content">${header}${body}</div></ha-card>`;

    this.shadowRoot.querySelectorAll("[data-toggle-route]").forEach((element) => {
      element.addEventListener("click", () => {
        const key = element.dataset.toggleRoute;
        const route = routeData.find((item) => item.key === key)?.route;
        const index = routeData.findIndex((item) => item.key === key);
        const current = this._expandedRoutes[key] ?? route?.open ?? index === 0;
        this._expandedRoutes[key] = !current;
        this._lastSignature = "";
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll("[data-route-action]").forEach((element) => {
      element.addEventListener("click", async () => {
        const routeItem = routeData.find((item) => item.key === element.dataset.routeKey);
        if (!routeItem) return;
        const action = element.dataset.routeAction;
        if (action === "now") {
          await this._resetRouteTime(routeItem);
          return;
        }
        if (action === "search") {
          const input = [...this.shadowRoot.querySelectorAll("[data-time-input]")]
            .find((candidate) => candidate.dataset.timeInput === routeItem.key);
          const date = input?.value ? new Date(input.value) : null;
          if (date && !Number.isNaN(date.getTime())) {
            this._navigationHistory[routeItem.key] = [];
            await this._setRouteTime(routeItem, date);
          }
          return;
        }
        await this._setRouteTime(routeItem, this._navigationTarget(routeItem, action));
      });
    });

    this.shadowRoot.querySelectorAll("[data-toggle-journey]").forEach((element) => {
      const toggle = () => {
        const entityId = element.dataset.toggleJourney;
        this._expandedJourneys[entityId] = !this._expandedJourneys[entityId];
        this._lastSignature = "";
        this._render();
      };
      element.addEventListener("click", toggle);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    });
    this.shadowRoot.querySelectorAll("[data-more-info]").forEach((element) => {
      element.addEventListener("click", () => this._openMoreInfo(element.dataset.moreInfo));
    });
  }

  _openMoreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      detail: { entityId },
    }));
  }
}

class DBNavigatorCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  _field(name, label, placeholder = "") {
    const value = this._config?.[name] ?? "";
    return `<label><span>${label}</span><input data-field="${name}" value="${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" placeholder="${placeholder}"></label>`;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;padding:12px 0;font-family:sans-serif} .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px} label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--secondary-text-color)} label.wide{grid-column:1/-1} input,textarea,select{padding:10px;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit} textarea{min-height:170px;resize:vertical;font-family:monospace;font-size:11px} textarea.invalid{border-color:var(--error-color,#db4437)} .hint{margin:12px 0 0;font-size:11px;line-height:1.4;color:var(--secondary-text-color)} @media(max-width:500px){.grid{grid-template-columns:1fr}}
    </style><div class="grid">
      ${this._field("title", "Titel", "Meine Reisen")}
      <label><span>Darstellung</span><select data-field="appearance"><option value="auto" ${!this._config.appearance || this._config.appearance === "auto" ? "selected" : ""}>Home-Assistant-Theme</option><option value="light" ${this._config.appearance === "light" ? "selected" : ""}>Hell</option><option value="dark" ${this._config.appearance === "dark" ? "selected" : ""}>Dunkel</option></select></label>
      <label><span>Kartendichte</span><select data-field="density"><option value="comfortable" ${!this._config.density || this._config.density === "comfortable" ? "selected" : ""}>Komfortabel</option><option value="compact" ${this._config.density === "compact" ? "selected" : ""}>Kompakt</option></select></label>
      ${this._field("max_connections", "Verbindungen je Strecke", "5")}
      <label class="wide"><span>Strecken (JSON-Liste)</span><textarea data-field="routes-json" placeholder='[{"title":"Zuhause → Arbeit","entity_prefix":"sensor.zuhause_arbeit_verbindung_"}]'>${JSON.stringify(this._config.routes || [], null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</textarea></label>
      <label class="wide"><span>Einzelnes Entity-Präfix (Legacy-Konfiguration)</span><input data-field="entity_prefix" value="${String(this._config.entity_prefix || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" placeholder="sensor.bahnhof_arbeit_verbindung_"></label>
      <label class="wide"><span>Entities (kommagetrennt, überschreibt Präfix)</span><input data-field="entities" value="${Array.isArray(this._config.entities) ? this._config.entities.join(", ") : (this._config.entities || "")}" placeholder="sensor.verbindung_1, sensor.verbindung_2"></label>
      ${this._field("person_entity", "Person für Richtungswechsel", "person.ferdinand")}
      ${this._field("home_state", "Zuhause-Status", "home")}
      ${this._field("home_prefix", "Präfix zuhause", "sensor.bahnhof_arbeit_verbindung_")}
      ${this._field("away_prefix", "Präfix unterwegs", "sensor.arbeit_bahnhof_verbindung_")}
    </div><p class="hint">Für mehrere Strecken die JSON-Liste verwenden. Pro Strecke werden die DB-Info-Entities für Abfahrtszeit, Custom-Time-Schalter und Refresh automatisch erkannt; abweichende IDs können als <code>datetime_entity</code>, <code>custom_time_entity</code> und <code>refresh_entity</code> eingetragen werden.</p>`;

    this.shadowRoot.querySelectorAll("input, textarea, select").forEach((input) => {
      input.addEventListener("change", (event) => this._changed(event));
    });
  }

  _changed(event) {
    const field = event.target.dataset.field;
    let value = event.target.value.trim();
    const config = { ...this._config };
    if (field === "routes-json") {
      try {
        const routes = value ? JSON.parse(value) : [];
        if (!Array.isArray(routes)) throw new Error("routes must be an array");
        config.routes = routes;
        event.target.classList.remove("invalid");
      } catch (_error) {
        event.target.classList.add("invalid");
        return;
      }
    } else if (!value) {
      delete config[field];
    } else if (field === "max_connections") {
      config[field] = Math.max(1, Math.min(12, Number(value) || 5));
    } else if (field === "entities") {
      config[field] = value.split(",").map((item) => item.trim()).filter(Boolean);
    } else {
      config[field] = value;
    }
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", {
      bubbles: true,
      composed: true,
      detail: { config },
    }));
  }
}

if (!customElements.get("db-navigator-card")) customElements.define("db-navigator-card", DBNavigatorCard);
if (!customElements.get("db-navigator-card-editor")) customElements.define("db-navigator-card-editor", DBNavigatorCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "db-navigator-card",
  name: "DB Navigator Card",
  description: "DB-Navigator-inspirierte Verbindungsübersicht für DB-Info-Sensoren",
  preview: true,
  documentationURL: "https://github.com/fbubeck/ha_db_navigator_widget",
});

console.info(`%c DB-NAVIGATOR-CARD %c v${DB_NAVIGATOR_CARD_VERSION} `, "color:#fff;background:#ec0016;font-weight:700", "color:#ec0016;background:#fff");
