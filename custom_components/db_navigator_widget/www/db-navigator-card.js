const DB_NAVIGATOR_CARD_VERSION = "0.2.0";

class DBNavigatorCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._lastSignature = "";
    this._expandedRoutes = {};
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
      ...config,
    };
    this._lastSignature = "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
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
    } else if (lower.includes("sev") || lower.includes("ersatzverkehr")) {
      kind = "replacement";
    } else if (/^(ice|ic|ec|re|rb|ire)\b/i.test(original)) {
      kind = /^(re|rb|ire)\b/i.test(original) ? "regional" : "longdistance";
    }
    return { kind, label: label || "Zug" };
  }

  _renderTransfer(details, index) {
    const previous = details[index - 1];
    const next = details[index + 1];
    let label = "🚶";
    let tight = false;
    if (previous && next) {
      const arrival = this._attr(previous, "Arrival Time Real", "Arrival Time", "arrival_time_real", "arrival_time");
      const departure = this._attr(next, "Departure Time Real", "Departure Time", "departure_time_real", "departure_time");
      const arrivalDate = this._asDate(arrival);
      const departureDate = this._asDate(departure);
      if (arrivalDate && departureDate) {
        const minutes = Math.max(0, Math.round((departureDate - arrivalDate) / 60000));
        label = minutes === 0 ? "⚡" : `${minutes}′`;
        tight = minutes <= 2;
      }
    }
    return `<span class="segment transfer ${tight ? "tight" : ""}" title="Umstiegszeit">${label}</span>`;
  }

  _renderSegments(attributes) {
    let details = this._parseDetails(this._attr(attributes, "Details", "details"));
    if (!details.length) {
      const summary = String(this._attr(attributes, "Name", "name") || "");
      details = summary.split(/\s*->\s*/).filter(Boolean).map((Name) => ({ Name }));
    }
    if (!details.length) return "";

    const segments = details.map((step, index) => {
      const transport = this._transport(this._attr(step, "Name", "name"));
      if (transport.kind === "walk") return this._renderTransfer(details, index);
      const titleParts = [
        this._attr(step, "Departure", "departure"),
        this._attr(step, "Arrival", "arrival"),
      ].filter(Boolean);
      return `<span class="segment ${transport.kind}" title="${this._escape(titleParts.join(" → "))}">${this._escape(transport.label)}</span>`;
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

  _renderRouteSection(routeData, index) {
    const { key, route, states } = routeData;
    const first = states[0];
    const departure = this._attr(first?.attributes, "Departure", "departure_station", "origin") || "Start";
    const arrival = this._attr(first?.attributes, "Arrival", "arrival_station", "destination") || "Ziel";
    const title = route.title || `${departure} → ${arrival}`;
    const firstDeparture = this._attr(first?.attributes, "Departure Time Real", "Departure Time", "departure_time_real", "departure_time");
    const isOpen = this._expandedRoutes[key] ?? route.open ?? index === 0;
    const journeys = states.length
      ? `<div class="list">${states.map((state) => this._renderJourney(state)).join("")}</div>`
      : `<div class="empty"><ha-icon icon="mdi:train-off"></ha-icon>Keine Verbindungen für diese Strecke gefunden.<code>${this._escape(this._activePrefix(route) || (route.entities || []).join?.(", ") || "Keine Entities konfiguriert")}</code></div>`;

    return `<section class="route-section ${isOpen ? "open" : ""}">
      <button class="route-header" data-toggle-route="${this._escape(key)}" aria-expanded="${isOpen}">
        <span class="route-symbol"><ha-icon icon="mdi:train"></ha-icon></span>
        <span class="route-heading"><strong>${this._escape(title)}</strong><small>${states.length} ${states.length === 1 ? "Verbindung" : "Verbindungen"}${firstDeparture ? ` · nächste ${this._escape(this._formatTime(firstDeparture))}` : ""}</small></span>
        <ha-icon class="route-chevron" icon="mdi:chevron-down"></ha-icon>
      </button>
      <div class="route-collapse"><div class="route-content">${journeys}${this._renderRouteControls(routeData)}</div></div>
    </section>`;
  }

  _renderJourney(state) {
    const attr = state.attributes || {};
    const depPlanned = this._attr(attr, "Departure Time", "departure_time");
    const depReal = this._attr(attr, "Departure Time Real", "departure_time_real");
    const arrPlanned = this._attr(attr, "Arrival Time", "arrival_time");
    const arrReal = this._attr(attr, "Arrival Time Real", "arrival_time_real");
    const departure = this._attr(attr, "Departure", "departure_station", "origin") || "Start";
    const arrival = this._attr(attr, "Arrival", "arrival_station", "destination") || "Ziel";
    const duration = this._attr(attr, "Duration", "duration") || "";
    const transfers = this._attr(attr, "Transfers", "transfers");
    const rawProblems = this._attr(attr, "Problems", "problems");
    const problems = ["null", "none"].includes(String(rawProblems || "").toLowerCase()) ? null : rawProblems;
    const details = this._parseDetails(this._attr(attr, "Details", "details"));
    const first = details.find((step) => this._transport(this._attr(step, "Name", "name")).kind !== "walk") || {};
    const last = [...details].reverse().find((step) => this._transport(this._attr(step, "Name", "name")).kind !== "walk") || {};
    const departurePlatform = this._attr(first, "Departure Platform", "departure_platform");
    const arrivalPlatform = this._attr(last, "Arrival Platform", "arrival_platform");
    const transferText = transfers !== null && transfers !== undefined
      ? `${transfers} ${Number(transfers) === 1 ? "Umstieg" : "Umstiege"}`
      : "";

    return `<article class="journey" data-entity="${this._escape(state.entity_id)}" tabindex="0" role="button" aria-label="Verbindung ${this._escape(departure)} nach ${this._escape(arrival)} öffnen">
      <div class="journey-top">
        <div class="times">
          ${this._renderTime(depPlanned, depReal, "Ab")}
          <span class="time-divider">–</span>
          ${this._renderTime(arrPlanned, arrReal, "An")}
        </div>
        <div class="meta">${[duration, transferText].filter(Boolean).map((value) => `<span>${this._escape(value)}</span>`).join("")}</div>
      </div>
      ${this._renderSegments(attr)}
      ${this._config.show_route === false ? "" : `<div class="route">
        <div><span class="dot start"></span><span>${this._escape(departure)}</span>${this._config.show_platforms !== false && departurePlatform ? `<small>Gl. ${this._escape(departurePlatform)}</small>` : ""}</div>
        <div><span class="dot end"></span><span>${this._escape(arrival)}</span>${this._config.show_platforms !== false && arrivalPlatform ? `<small>Gl. ${this._escape(arrivalPlatform)}</small>` : ""}</div>
      </div>`}
      ${problems ? `<div class="problem"><ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${this._escape(problems)}</span></div>` : ""}
    </article>`;
  }

  _styles() {
    return `
      :host { display:block; --db-red:#ec0016; --db-ink:#282d37; font-family:var(--paper-font-body1_-_font-family, -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif); }
      * { box-sizing:border-box; }
      ha-card { overflow:hidden; border-radius:16px; background:var(--secondary-background-color, #f4f5f6); color:var(--primary-text-color, #282d37); border:0; box-shadow:var(--ha-card-box-shadow, 0 4px 14px rgba(0,0,0,.10)); }
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
      .count { flex:0 0 auto; padding:4px 8px; border-radius:999px; background:var(--card-background-color, #fff); color:var(--secondary-text-color, #626975); font-size:10px; font-weight:800; box-shadow:0 1px 4px rgba(0,0,0,.06); }
      .routes { display:flex; flex-direction:column; gap:10px; }
      .route-section { overflow:hidden; border-radius:13px; background:var(--card-background-color, #fff); box-shadow:0 2px 8px rgba(20,24,30,.08); }
      .route-header { display:grid; grid-template-columns:34px minmax(0,1fr) 24px; align-items:center; gap:10px; width:100%; padding:12px 13px; border:0; background:transparent; color:var(--primary-text-color, #282d37); text-align:left; cursor:pointer; }
      .route-header:hover { background:color-mix(in srgb, var(--primary-text-color, #282d37) 4%, transparent); }
      .route-symbol { display:grid; place-items:center; width:32px; height:32px; border-radius:50%; background:#ec0016; color:#fff; }
      .route-symbol ha-icon { --mdc-icon-size:19px; }
      .route-heading { display:flex; flex-direction:column; min-width:0; gap:3px; }
      .route-heading strong { overflow:hidden; font-size:14px; text-overflow:ellipsis; white-space:nowrap; }
      .route-heading small { color:var(--secondary-text-color, #69717c); font-size:10px; }
      .route-chevron { --mdc-icon-size:22px; color:var(--secondary-text-color, #69717c); transition:transform .22s ease; }
      .route-section.open .route-chevron { transform:rotate(180deg); }
      .route-collapse { display:grid; grid-template-rows:0fr; transition:grid-template-rows .25s ease; }
      .route-section.open .route-collapse { grid-template-rows:1fr; }
      .route-content { min-height:0; overflow:hidden; }
      .route-content > .list, .route-content > .empty { margin:0 10px; }
      .route-content > .list { padding-top:2px; }
      .list { display:flex; flex-direction:column; gap:9px; }
      .route-content .journey { border:1px solid var(--divider-color, #e4e6e8); border-left:4px solid var(--db-red); box-shadow:none; }
      .navigation { margin:10px; padding:10px; border-radius:10px; background:var(--secondary-background-color, #f4f5f6); }
      .nav-buttons { display:grid; grid-template-columns:1fr auto 1fr; gap:7px; }
      .nav-buttons button, .search-time { display:flex; align-items:center; justify-content:center; gap:3px; min-height:36px; border:1px solid var(--divider-color, #d7d9dc); border-radius:8px; background:var(--card-background-color, #fff); color:var(--primary-text-color, #282d37); font-size:11px; font-weight:800; cursor:pointer; }
      .nav-buttons button:hover, .search-time:hover { border-color:#ec0016; color:#ec0016; }
      .nav-buttons button:disabled, .search-time:disabled { opacity:.42; cursor:not-allowed; }
      .nav-buttons ha-icon { --mdc-icon-size:18px; }
      .now-button { min-width:68px; border-color:#ec0016 !important; color:#ec0016 !important; }
      .custom-active .now-button::before { content:""; width:6px; height:6px; border-radius:50%; background:#ec0016; }
      .time-picker { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; margin-top:8px; }
      .time-picker input { min-width:0; min-height:36px; padding:5px 8px; border:1px solid var(--divider-color, #d7d9dc); border-radius:8px; background:var(--card-background-color, #fff); color:var(--primary-text-color, #282d37); font:inherit; font-size:11px; }
      .search-time { padding:0 13px; background:#ec0016; border-color:#ec0016; color:#fff; }
      .search-time:hover { background:#c90018; color:#fff; }
      .control-hint { margin-top:7px; color:var(--secondary-text-color, #69717c); font-size:9px; line-height:1.35; }
      .control-hint code { color:inherit; }

      .journey { background:var(--card-background-color, #fff); border-radius:12px; padding:13px 14px; border-left:4px solid var(--db-red); box-shadow:0 2px 7px rgba(20,24,30,.07); cursor:pointer; outline:none; transition:transform .14s ease, box-shadow .14s ease; }
      .journey:hover, .journey:focus-visible { transform:translateY(-1px); box-shadow:0 5px 14px rgba(20,24,30,.12); }
      .journey:focus-visible { box-shadow:0 0 0 2px var(--db-red), 0 5px 14px rgba(20,24,30,.12); }
      .journey-top { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
      .times { display:flex; align-items:flex-end; gap:7px; min-width:0; }
      .time { display:grid; grid-template-columns:auto auto; align-items:baseline; column-gap:4px; line-height:1; }
      .time-label { grid-column:1/-1; margin-bottom:3px; font-size:9px; font-weight:800; color:#848a94; text-transform:uppercase; letter-spacing:.5px; }
      .time strong { font-size:18px; font-variant-numeric:tabular-nums; color:var(--primary-text-color, #20242a); }
      .time.ontime strong, .time.early strong { color:#138a42; }
      .time.delayed strong, .time.delayed .delay { color:#d20a1e; }
      .planned { font-size:11px; color:#777f89; text-decoration:line-through; font-variant-numeric:tabular-nums; }
      .delay { font-size:10px; font-weight:900; }
      .time-divider { padding-bottom:2px; color:#9ba0a8; font-weight:500; }
      .meta { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:4px; color:#6d747e; font-size:11px; font-weight:650; }
      .meta span + span::before { content:"•"; margin-right:4px; color:#b0b4bb; }
      .segments { display:flex; align-items:stretch; gap:3px; margin:10px 0 9px; min-height:28px; }
      .segment { display:flex; align-items:center; justify-content:center; min-width:42px; flex:1 1 0; overflow:hidden; padding:6px 7px; border-radius:5px; background:#282d37; color:#fff; font-size:11px; font-weight:850; letter-spacing:.15px; text-overflow:ellipsis; white-space:nowrap; }
      .segment.transfer { flex:0 0 auto; min-width:28px; background:#e7e9ec; color:#59616c; }
      .segment.transfer.tight { background:#fde1e4; color:#c90018; }
      .segment.suburban { background:#178447; }
      .segment.urban { background:#005ca9; }
      .segment.bus { background:#7b2d75; }
      .segment.tram { background:#c86200; }
      .segment.mex { background:#f5c400; color:#20242a; }
      .segment.regional { background:#5c626b; }
      .segment.longdistance { background:#ec0016; }
      .segment.replacement { background:#8a3ffc; }
      .route { position:relative; display:grid; gap:5px; color:var(--secondary-text-color, #555d67); font-size:11px; }
      .route::before { content:""; position:absolute; left:4px; top:6px; bottom:6px; width:1px; background:#b8bdc4; }
      .route > div { position:relative; display:grid; grid-template-columns:10px minmax(0,1fr) auto; align-items:center; gap:7px; min-width:0; }
      .route > div > span:nth-child(2) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .dot { z-index:1; width:9px; height:9px; border:2px solid #727983; border-radius:50%; background:var(--card-background-color, #fff); }
      .dot.end { background:#727983; }
      .route small { color:#7d848d; font-size:10px; font-weight:700; }
      .problem { display:flex; align-items:flex-start; gap:5px; margin-top:9px; padding:7px 8px; border-radius:7px; background:#fff0d6; color:#7a4c00; font-size:10px; line-height:1.3; }
      .problem ha-icon { --mdc-icon-size:15px; flex:0 0 auto; }
      .empty { padding:22px 14px; border-radius:12px; background:var(--card-background-color, #fff); color:var(--secondary-text-color, #69717c); text-align:center; font-size:12px; line-height:1.45; }
      .empty ha-icon { display:block; margin:0 auto 8px; --mdc-icon-size:30px; color:#a2a7ae; }
      .empty code { display:block; margin-top:6px; color:#343a42; word-break:break-all; }
      @media (max-width:420px) {
        .content { padding:11px; }
        .journey { padding:12px 11px; }
        .header { padding-bottom:10px; }
        .headline { font-size:14px; }
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
    const uiSignature = JSON.stringify({ expanded: this._expandedRoutes, loading: this._loadingRoutes });
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
    this.shadowRoot.innerHTML = `<style>${this._styles()}</style><ha-card><div class="db-stripe"></div><div class="content">${header}${body}</div></ha-card>`;

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

    this.shadowRoot.querySelectorAll(".journey").forEach((element) => {
      const open = () => this._openMoreInfo(element.dataset.entity);
      element.addEventListener("click", open);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
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
      :host{display:block;padding:12px 0;font-family:sans-serif} .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px} label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--secondary-text-color)} label.wide{grid-column:1/-1} input,textarea{padding:10px;border:1px solid var(--divider-color);border-radius:8px;background:var(--card-background-color);color:var(--primary-text-color);font:inherit} textarea{min-height:170px;resize:vertical;font-family:monospace;font-size:11px} textarea.invalid{border-color:var(--error-color,#db4437)} .hint{margin:12px 0 0;font-size:11px;line-height:1.4;color:var(--secondary-text-color)} @media(max-width:500px){.grid{grid-template-columns:1fr}}
    </style><div class="grid">
      ${this._field("title", "Titel", "Meine Reisen")}
      ${this._field("max_connections", "Verbindungen je Strecke", "5")}
      <label class="wide"><span>Strecken (JSON-Liste)</span><textarea data-field="routes-json" placeholder='[{"title":"Zuhause → Arbeit","entity_prefix":"sensor.zuhause_arbeit_verbindung_"}]'>${JSON.stringify(this._config.routes || [], null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</textarea></label>
      <label class="wide"><span>Einzelnes Entity-Präfix (Legacy-Konfiguration)</span><input data-field="entity_prefix" value="${String(this._config.entity_prefix || "").replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" placeholder="sensor.bahnhof_arbeit_verbindung_"></label>
      <label class="wide"><span>Entities (kommagetrennt, überschreibt Präfix)</span><input data-field="entities" value="${Array.isArray(this._config.entities) ? this._config.entities.join(", ") : (this._config.entities || "")}" placeholder="sensor.verbindung_1, sensor.verbindung_2"></label>
      ${this._field("person_entity", "Person für Richtungswechsel", "person.ferdinand")}
      ${this._field("home_state", "Zuhause-Status", "home")}
      ${this._field("home_prefix", "Präfix zuhause", "sensor.bahnhof_arbeit_verbindung_")}
      ${this._field("away_prefix", "Präfix unterwegs", "sensor.arbeit_bahnhof_verbindung_")}
    </div><p class="hint">Für mehrere Strecken die JSON-Liste verwenden. Pro Strecke werden die DB-Info-Entities für Abfahrtszeit, Custom-Time-Schalter und Refresh automatisch erkannt; abweichende IDs können als <code>datetime_entity</code>, <code>custom_time_entity</code> und <code>refresh_entity</code> eingetragen werden.</p>`;

    this.shadowRoot.querySelectorAll("input, textarea").forEach((input) => {
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
