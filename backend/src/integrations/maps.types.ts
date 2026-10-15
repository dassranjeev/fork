/** Shared shapes of the maps providers (Mapbox and Google): both answer in exactly these, so the rest of the app never knows which one is active. */

export type MapsProviderName = 'mapbox' | 'google';

export interface GeoAddress {
  line1: string;
  city: string;
  province: string;
  postalCode: string;
  lat: number;
  lng: number;
  label: string;
}

export interface GeoSuggestion {
  id: string;
  label: string;
  line1: string;
  secondary: string;
}

export type AutocompleteResult = { enabled: boolean; suggestions: GeoSuggestion[]; error?: string };
export type RetrieveResult = { enabled: boolean; address?: GeoAddress; error?: string };
export type ReverseResult = { enabled: boolean; address?: GeoAddress | null; error?: string };

/** The area address search is limited to. One setting set (integrations.mapbox.country / bbox / proximity) serves both providers. */
export interface SearchArea {
  country: string;
  /** "minLng,minLat,maxLng,maxLat" or empty */
  bbox: string;
  /** "lng,lat" or empty */
  proximity: string;
}

/** A driving route between two points. `source` says where the numbers come from. */
export interface RouteResult {
  km: number;
  minutes: number;
  source: 'mapbox' | 'google' | 'estimate';
}

/** What a browser needs to draw the map (public tokens only; the server keys never leave the server). `null` url = use the free OpenStreetMap tiles. */
export interface TileConfig {
  provider: MapsProviderName | 'osm';
  /** Leaflet tile URL template ({z} {x} {y} {r}) or null */
  url: string | null;
  attribution: string;
  tileSize: number;
  maxZoom: number;
}

export const OSM_TILES: TileConfig = {
  provider: 'osm',
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  tileSize: 256,
  maxZoom: 19,
};

export interface TestOutcome {
  ok: boolean;
  reason?: string;
  sample?: string;
  latencyMs?: number;
  [k: string]: any;
}
