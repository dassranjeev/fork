/** Geo helpers (no PostGIS dependency; PostGIS can replace these later). */

const R = 6371; // km

const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Approximate road distance/ETA fallback when Google Maps is not configured (x1.3 detour factor, 28 km/h city average). */
export function roadEstimate(lat1: number, lng1: number, lat2: number, lng2: number, kmh = 28) {
  const km = haversineKm(lat1, lng1, lat2, lng2) * 1.3;
  return { km, minutes: Math.max(1, Math.round((km / kmh) * 60)) };
}

/** Ray casting point-in-polygon. polygon = [[lat,lng], ...] */
export function pointInPolygon(lat: number, lng: number, polygon: [number, number][]): boolean {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** SQL fragment for Haversine distance (km) between column pair and a point. Use with parameters :lat :lng. */
export function haversineSql(latCol: string, lngCol: string, latParam = ':lat', lngParam = ':lng') {
  return `(6371 * acos(LEAST(1, cos(radians(${latParam})) * cos(radians(${latCol})) * cos(radians(${lngCol}) - radians(${lngParam})) + sin(radians(${latParam})) * sin(radians(${latCol})))))`;
}
