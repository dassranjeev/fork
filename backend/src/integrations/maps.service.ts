import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { roadEstimate } from '../common/geo.util';
import { GoogleMapsService } from './google-maps.service';
import { MapboxService } from './mapbox.service';
import { AutocompleteResult, MapsProviderName, OSM_TILES, RetrieveResult, ReverseResult, RouteResult, TileConfig } from './maps.types';

export const MAPS_PROVIDERS: MapsProviderName[] = ['mapbox', 'google'];
export const MAPS_PROVIDER_KEY = 'integrations.maps.provider';
export const MAPS_ROUTING_KEY = 'integrations.maps.routingEnabled';

const DAY_MS = 24 * 3_600_000;
const FALLBACK_MS = 10 * 60_000;
const MAX_ROUTES = 5000;

const r5 = (n: number) => n.toFixed(5);

/**
 * The one entry point for everything that needs a map provider. A Super Admin picks the provider (System > Integrations > Maps); Mapbox is the default and
 * the Google configuration stays in place, so switching is one click and takes effect at once:
 *   - address search (autocomplete / retrieve / reverse)   -> the active provider, through the FORKSY API (no key reaches a browser)
 *   - road distance and drive time of a delivery            -> the active provider when "road distances" is switched on, else the built-in estimate
 *   - map tiles of the admin screens                        -> the active provider's tile URL (public key only), else OpenStreetMap
 * Whatever the provider cannot do (no key, rejected key, outage) degrades to the old behaviour: manual address entry, the estimate, OpenStreetMap.
 */
@Injectable()
export class MapsService {
  private readonly logger = new Logger('Maps');
  private routes = new Map<string, { at: number; ttl: number; value: RouteResult }>();

  constructor(private settings: SettingsService, private mapbox: MapboxService, private google: GoogleMapsService) {}

  /** The provider in use. Anything unexpected stored in the setting means Mapbox. */
  provider(): MapsProviderName {
    return this.settings.get<string>(MAPS_PROVIDER_KEY, 'mapbox') === 'google' ? 'google' : 'mapbox';
  }

  private active() {
    return this.provider() === 'google' ? this.google : this.mapbox;
  }

  /** The active provider has a server key: address search works. */
  get enabled(): boolean {
    return this.active().enabled;
  }

  // ------------------------------------------------------------------ address search
  autocomplete(q: string, opts: { proximity?: string; sessionToken: string }): Promise<AutocompleteResult> {
    return this.active().autocomplete(q, opts);
  }
  retrieve(id: string, sessionToken: string): Promise<RetrieveResult> {
    return this.active().retrieve(id, sessionToken);
  }
  reverse(lat: number, lng: number): Promise<ReverseResult> {
    return this.active().reverse(lat, lng);
  }

  // ------------------------------------------------------------------ road distance and time
  /** "Use real road distances and drive times" switch (default off: the built-in estimate keeps today's delivery fees). */
  get routingEnabled(): boolean {
    return this.settings.get<boolean>(MAPS_ROUTING_KEY, false) === true && this.enabled;
  }

  /**
   * Driving distance and time of one trip. With the switch off, or when the provider cannot answer, this is the built-in estimate (straight line x 1.3, 28 km/h)
   * so a quote never fails because of the map provider. Answers are remembered (a real route for a day, a fallback for ten minutes), so the same trip prices the
   * same in the quote, the payment and the order, even if the provider hiccups in between. Never throws.
   */
  async route(from: { lat: number; lng: number }, to: { lat: number; lng: number }, kmh = 28): Promise<RouteResult> {
    const estimate = (): RouteResult => ({ ...roadEstimate(from.lat, from.lng, to.lat, to.lng, kmh), source: 'estimate' });
    if (!this.routingEnabled) return estimate();
    const provider = this.provider();
    const key = `${provider}|${r5(from.lat)},${r5(from.lng)}|${r5(to.lat)},${r5(to.lng)}`;
    const hit = this.routes.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
    let value: RouteResult;
    let ttl = DAY_MS;
    try {
      value = await (provider === 'google' ? this.google : this.mapbox).route(from, to);
    } catch (e: any) {
      this.logger.warn(`${provider} could not route ${r5(from.lat)},${r5(from.lng)} -> ${r5(to.lat)},${r5(to.lng)} (${e?.message ?? 'error'}): using the estimate`);
      value = estimate();
      ttl = FALLBACK_MS;
    }
    if (this.routes.size >= MAX_ROUTES) this.routes.delete(this.routes.keys().next().value as string);
    this.routes.set(key, { at: Date.now(), ttl, value });
    return value;
  }

  // ------------------------------------------------------------------ map tiles
  /** What the admin screens draw the map with. Only public keys ever leave the server. */
  async tiles(): Promise<TileConfig> {
    const t = this.provider() === 'google' ? await this.google.tileConfig() : this.mapbox.tileConfig();
    return t ?? OSM_TILES;
  }

  async clientConfig() {
    const tiles = await this.tiles();
    return { provider: this.provider(), addressSearch: this.enabled, roadDistances: this.routingEnabled, tiles };
  }

  clearCaches() {
    this.routes.clear();
    this.mapbox.clearCache();
    this.google.clearCache();
  }
}
