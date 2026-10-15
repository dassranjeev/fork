import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { KeySource } from './stripe-client.service';
import { AutocompleteResult, GeoAddress, GeoSuggestion, RetrieveResult, ReverseResult, RouteResult, TestOutcome, TileConfig } from './maps.types';

export interface GoogleConfig {
  /** server key: address search, routes, creating the tile session. Never sent to a browser. */
  key: string;
  keySource: KeySource;
  /** browser key (restrict it to your website addresses in the Google console): only used in the map tile URL */
  browserKey: string;
  browserKeySource: KeySource;
  country: string;
  bbox: string;
  proximity: string;
}

/** Google API keys are "AIza" + 35 characters. */
export const GOOGLE_KEY_RE = /^AIza[0-9A-Za-z_-]{35}$/;

const TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 2000;

type Host = 'places' | 'maps' | 'routes' | 'tile';

/**
 * Google Maps Platform as the maps provider (the same jobs as MapboxService, with the same answers): address search (Places API New:
 * autocomplete + place details, Geocoding API for reverse), driving routes (Routes API) and map tiles for browsers (Map Tiles API, 2D tiles).
 * The server key never reaches a browser. Without a key every address method answers { enabled:false }.
 * GOOGLE_API_BASE points every Google host at one fake server (development / tests only, ignored in production).
 */
@Injectable()
export class GoogleMapsService {
  private readonly logger = new Logger('GoogleMaps');
  private cache = new Map<string, { at: number; value: any }>();
  private session: { token: string; expiresAt: number; key: string } | null = null;

  constructor(private settings: SettingsService) {}

  config(): GoogleConfig {
    const s = this.settings.get<string>('integrations.google.apiKey', '');
    const env = (process.env.GOOGLE_MAPS_API_KEY ?? '').trim();
    const b = this.settings.get<string>('integrations.google.browserKey', '');
    const envB = (process.env.GOOGLE_MAPS_BROWSER_KEY ?? '').trim();
    const key = (typeof s === 'string' && s.trim()) || env;
    const browserKey = (typeof b === 'string' && b.trim()) || envB;
    return {
      key,
      keySource: typeof s === 'string' && s.trim() ? 'settings' : env ? 'env' : 'none',
      browserKey,
      browserKeySource: typeof b === 'string' && b.trim() ? 'settings' : envB ? 'env' : 'none',
      // the search area is one set of settings for both providers
      country: String(this.settings.get<string>('integrations.mapbox.country', 'ca') || 'ca').toLowerCase(),
      bbox: String(this.settings.get<string>('integrations.mapbox.bbox', '') ?? '').trim(),
      proximity: String(this.settings.get<string>('integrations.mapbox.proximity', '') ?? '').trim(),
    };
  }

  get enabled(): boolean {
    return !!this.config().key;
  }

  private override(): string {
    const raw = (process.env.GOOGLE_API_BASE ?? '').trim().replace(/\/+$/, '');
    return raw && process.env.NODE_ENV !== 'production' ? raw : '';
  }
  private url(host: Host, path: string): string {
    return `${this.override() || `https://${host}.googleapis.com`}${path}`;
  }

  private cached<T>(key: string): T | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }
  private remember(key: string, value: any) {
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
  }
  clearCache() {
    this.cache.clear();
    this.session = null;
  }

  /** One HTTP call to Google. The key travels only server -> Google (header or query), never into a log or an error message. */
  private async call(method: 'GET' | 'POST', url: string, opts: { key: string; fieldMask?: string; body?: any; keyInQuery?: boolean }): Promise<any> {
    const u = new URL(url);
    if (opts.keyInQuery) u.searchParams.set('key', opts.key);
    let res: Response;
    try {
      res = await fetch(u, {
        method,
        headers: { accept: 'application/json', ...(opts.keyInQuery ? {} : { 'x-goog-api-key': opts.key }), ...(opts.fieldMask ? { 'x-goog-fieldmask': opts.fieldMask } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch (e: any) {
      this.logger.warn(`Google request failed: ${e?.name ?? 'error'}`);
      throw new BadGatewayException('Address search is unavailable right now');
    }
    if (res.status === 401 || res.status === 403) throw new BadGatewayException('GOOGLE_AUTH');
    if (res.status === 429) throw new BadGatewayException('Address search is busy, please try again in a moment');
    if (res.status === 400) {
      const t = await res.text().catch(() => '');
      if (/API_KEY_INVALID|API key not valid|keyInvalid/i.test(t)) throw new BadGatewayException('GOOGLE_AUTH');
      this.logger.warn('Google answered HTTP 400');
      throw new BadGatewayException('Address search is unavailable right now');
    }
    if (!res.ok) {
      this.logger.warn(`Google answered HTTP ${res.status}`);
      throw new BadGatewayException('Address search is unavailable right now');
    }
    return res.json();
  }

  // ------------------------------------------------------------------ address search
  /** Mapbox "bbox" (minLng,minLat,maxLng,maxLat) as a Google rectangle. */
  private rectangle(bbox: string) {
    const p = bbox.split(',').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
    return { low: { latitude: p[1], longitude: p[0] }, high: { latitude: p[3], longitude: p[2] } };
  }

  async autocomplete(q: string, opts: { proximity?: string; sessionToken: string }): Promise<AutocompleteResult> {
    const cfg = this.config();
    if (!cfg.key) return { enabled: false, suggestions: [] };
    const key = `s|${q.toLowerCase()}|${opts.proximity ?? ''}`;
    const hit = this.cached<GeoSuggestion[]>(key);
    if (hit) return { enabled: true, suggestions: hit };
    const body: any = { input: q, sessionToken: opts.sessionToken, languageCode: 'en', includedRegionCodes: cfg.country.split(',').slice(0, 15), includedPrimaryTypes: ['street_address', 'premise', 'subpremise'] };
    const rect = cfg.bbox ? this.rectangle(cfg.bbox) : null;
    const prox = (opts.proximity || cfg.proximity).split(',').map(Number);
    // Google accepts either a hard area or a bias, not both: the bounding box wins, the proximity biases when there is no box
    if (rect) body.locationRestriction = { rectangle: rect };
    else if (prox.length === 2 && prox.every(Number.isFinite)) body.locationBias = { circle: { center: { latitude: prox[1], longitude: prox[0] }, radius: 50000 } };
    try {
      const j = await this.call('POST', this.url('places', '/v1/places:autocomplete'), { key: cfg.key, body });
      const out: GeoSuggestion[] = (j?.suggestions ?? [])
        .map((s: any) => s?.placePrediction)
        .filter((p: any) => p?.placeId)
        .slice(0, 6)
        .map((p: any) => ({
          id: String(p.placeId),
          line1: String(p.structuredFormat?.mainText?.text ?? p.text?.text ?? ''),
          secondary: String(p.structuredFormat?.secondaryText?.text ?? ''),
          label: String(p.text?.text ?? [p.structuredFormat?.mainText?.text, p.structuredFormat?.secondaryText?.text].filter(Boolean).join(', ')),
        }));
      this.remember(key, out);
      return { enabled: true, suggestions: out };
    } catch (e: any) {
      return this.softFail(e);
    }
  }

  async retrieve(id: string, sessionToken: string): Promise<RetrieveResult> {
    const cfg = this.config();
    if (!cfg.key) return { enabled: false };
    const key = `r|${id}`;
    const hit = this.cached<GeoAddress>(key);
    if (hit) return { enabled: true, address: hit };
    try {
      const url = new URL(this.url('places', `/v1/places/${encodeURIComponent(id)}`));
      url.searchParams.set('sessionToken', sessionToken);
      url.searchParams.set('languageCode', 'en');
      const j = await this.call('GET', url.toString(), { key: cfg.key, fieldMask: 'id,formattedAddress,location,addressComponents' });
      const addr = this.fromPlace(j);
      if (!addr) throw new BadRequestException('That address could not be located');
      this.remember(key, addr);
      return { enabled: true, address: addr };
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      return this.softFail(e);
    }
  }

  async reverse(lat: number, lng: number): Promise<ReverseResult> {
    const cfg = this.config();
    if (!cfg.key) return { enabled: false };
    const key = `v|${lat.toFixed(5)},${lng.toFixed(5)}`;
    const hit = this.cached<GeoAddress | null>(key);
    if (hit !== undefined) return { enabled: true, address: hit };
    try {
      const url = new URL(this.url('maps', '/maps/api/geocode/json'));
      url.searchParams.set('latlng', `${lat},${lng}`);
      url.searchParams.set('result_type', 'street_address');
      url.searchParams.set('language', 'en');
      const j = await this.call('GET', url.toString(), { key: cfg.key, keyInQuery: true });
      // the older Geocoding API answers HTTP 200 and says what is wrong in "status"
      if (j?.status === 'REQUEST_DENIED') throw new BadGatewayException('GOOGLE_AUTH');
      if (j?.status === 'OVER_QUERY_LIMIT') throw new BadGatewayException('Address search is busy, please try again in a moment');
      const addr = j?.status === 'OK' ? this.fromGeocode(j.results?.[0]) : null;
      this.remember(key, addr);
      return { enabled: true, address: addr };
    } catch (e: any) {
      return this.softFail(e);
    }
  }

  private softFail(e: any): any {
    if (e instanceof BadGatewayException && e.message === 'GOOGLE_AUTH') {
      this.logger.error('Google rejected the API key (invalid, restricted, or the Places / Geocoding API is not enabled) - address search is off until it is fixed');
      return { enabled: false, error: 'Address search is not available', suggestions: [] };
    }
    return { enabled: true, error: e?.message ?? 'Address search is unavailable right now', suggestions: [] };
  }

  private pick(components: any[], type: string, short = false): string {
    const c = (components ?? []).find((x: any) => (x.types ?? []).includes(type));
    return c ? String((short ? c.shortText ?? c.short_name : c.longText ?? c.long_name) ?? '') : '';
  }

  /** Google Place (New) -> FORKY address. */
  fromPlace(p: any): GeoAddress | null {
    const lat = Number(p?.location?.latitude);
    const lng = Number(p?.location?.longitude);
    if (!p || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const comps: any[] = p.addressComponents ?? [];
    return this.build(comps, lat, lng, p.formattedAddress);
  }

  /** Google Geocoding result -> FORKY address. */
  fromGeocode(r: any): GeoAddress | null {
    const lat = Number(r?.geometry?.location?.lat);
    const lng = Number(r?.geometry?.location?.lng);
    if (!r || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return this.build(r.address_components ?? [], lat, lng, r.formatted_address);
  }

  private build(comps: any[], lat: number, lng: number, formatted?: string): GeoAddress {
    const line1 = [this.pick(comps, 'street_number'), this.pick(comps, 'route')].filter(Boolean).join(' ');
    const city = this.pick(comps, 'locality') || this.pick(comps, 'postal_town') || this.pick(comps, 'sublocality') || this.pick(comps, 'administrative_area_level_2');
    const province = this.pick(comps, 'administrative_area_level_1', true);
    return {
      line1: (line1 || String(formatted ?? '').split(',')[0]).slice(0, 200),
      city: city.slice(0, 80),
      province: province.slice(0, 40),
      postalCode: this.pick(comps, 'postal_code').toUpperCase().slice(0, 12),
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      label: String(formatted ?? [line1, city, province].filter(Boolean).join(', ')).slice(0, 300),
    };
  }

  // ------------------------------------------------------------------ routes
  /** Driving distance and time (Routes API, no live traffic: the same trip always answers the same). Throws when Google cannot answer. */
  async route(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteResult> {
    const cfg = this.config();
    if (!cfg.key) throw new BadGatewayException('GOOGLE_OFF');
    const pt = (p: { lat: number; lng: number }) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const j = await this.call('POST', this.url('routes', '/directions/v2:computeRoutes'), {
      key: cfg.key,
      fieldMask: 'routes.distanceMeters,routes.duration',
      body: { origin: pt(from), destination: pt(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', units: 'METRIC' },
    });
    const r = j?.routes?.[0];
    const m = Number(r?.distanceMeters);
    const s = parseFloat(String(r?.duration ?? '').replace(/s$/, ''));
    if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0) throw new BadGatewayException('Google found no route');
    return { km: m / 1000, minutes: Math.max(1, Math.round(s / 60)), source: 'google' };
  }

  // ------------------------------------------------------------------ map tiles
  /** Map Tiles API session (kept until shortly before it expires). */
  private async tileSession(key: string): Promise<string> {
    if (this.session && this.session.key === key && this.session.expiresAt - Date.now() > 3_600_000) return this.session.token;
    const j = await this.call('POST', this.url('tile', '/v1/createSession'), { key, keyInQuery: true, body: { mapType: 'roadmap', language: 'en-CA', region: 'CA' } });
    const token = String(j?.session ?? '');
    if (!token) throw new BadGatewayException('Google did not create a map session');
    const exp = Number(j?.expiry);
    this.session = { token, key, expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : Date.now() + 6 * 3_600_000 };
    return token;
  }

  /** Google map tiles for browsers: needs the server key (to create the session) AND the browser key (in the tile URL). null otherwise. */
  async tileConfig(): Promise<TileConfig | null> {
    const c = this.config();
    if (!c.key || !c.browserKey || !GOOGLE_KEY_RE.test(c.browserKey)) return null;
    try {
      const session = await this.tileSession(c.key);
      return {
        provider: 'google',
        url: `${this.url('tile', '/v1/2dtiles/{z}/{x}/{y}')}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(c.browserKey)}`,
        attribution: 'Map data &copy; Google',
        tileSize: 256,
        maxZoom: 21,
      };
    } catch (e: any) {
      this.logger.warn(`Google map tiles are not available: ${e?.message ?? 'error'}`);
      return null;
    }
  }

  // ------------------------------------------------------------------ admin "Test connection"
  async test(): Promise<TestOutcome & { country: string; bbox: string }> {
    const cfg = this.config();
    const base = { country: cfg.country, bbox: cfg.bbox };
    if (!cfg.key) return { ok: false, reason: 'No Google Maps API key is configured', ...base };
    const t0 = Date.now();
    try {
      const body: any = { input: '1 City Centre Dr Mississauga', sessionToken: 'forky-connection-test', languageCode: 'en', includedRegionCodes: cfg.country.split(',').slice(0, 15), includedPrimaryTypes: ['street_address', 'premise', 'subpremise'] };
      const rect = cfg.bbox ? this.rectangle(cfg.bbox) : null;
      if (rect) body.locationRestriction = { rectangle: rect };
      const j = await this.call('POST', this.url('places', '/v1/places:autocomplete'), { key: cfg.key, body });
      const first = (j?.suggestions ?? []).map((s: any) => s?.placePrediction).find((p: any) => p?.placeId);
      if (!first) return { ok: false, reason: 'Google answered but found no address for the test search (check the country / bounding box settings and that the Places API (New) is enabled)', latencyMs: Date.now() - t0, ...base };
      let routing: { ok: boolean; km?: number; minutes?: number; reason?: string };
      try {
        const r = await this.route({ lat: 43.5931, lng: -79.6413 }, { lat: 43.6114, lng: -79.6296 });
        routing = { ok: true, km: Math.round(r.km * 100) / 100, minutes: r.minutes };
      } catch (e: any) {
        routing = { ok: false, reason: e?.message === 'GOOGLE_AUTH' ? 'The key cannot use the Routes API (enable it in the Google console; road distance and time fall back to the estimate)' : String(e?.message ?? 'Routes request failed') };
      }
      const tiles: { ok: boolean; reason?: string } = !cfg.browserKey
        ? { ok: false, reason: 'No browser key is set: the maps on the admin screens use OpenStreetMap' }
        : (await this.tileConfig())
          ? { ok: true }
          : { ok: false, reason: 'Google would not create a map session (enable the Map Tiles API for the key)' };
      return { ok: true, sample: String(first.text?.text ?? ''), latencyMs: Date.now() - t0, routing, tiles, ...base };
    } catch (e: any) {
      const reason = e?.message === 'GOOGLE_AUTH' ? 'Google rejected the API key (invalid, restricted, or the Places API (New) is not enabled)' : String(e?.message ?? 'Google request failed');
      return { ok: false, reason, latencyMs: Date.now() - t0, ...base };
    }
  }
}
