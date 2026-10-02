import React, { useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, Marker, Polygon, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { escapeHtml, safeColor } from "../lib/safe";

export const DEFAULT_CENTER = [43.589, -79.6441]; // Mississauga

// divIcon based coloured pins (avoids bundler issues with leaflet default images)
const iconCache = {};
export function pin(color = "#f95a16", glyph = "", size = 30) {
  // these values end up in an HTML string (L.divIcon): never trust them
  color = safeColor(color, "#f95a16");
  glyph = escapeHtml(glyph);
  size = Number(size) || 30;
  const key = `${color}|${glyph}|${size}`;
  if (!iconCache[key]) {
    iconCache[key] = L.divIcon({
      className: "forksy-pin",
      html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);color:#fff;font-size:${Math.round(size * 0.45)}px;font-weight:700">${glyph}</span></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size],
      popupAnchor: [0, -size],
    });
  }
  return iconCache[key];
}

export function dot(color = "#22c55e", size = 16) {
  color = safeColor(color, "#22c55e");
  size = Number(size) || 16;
  const key = `dot|${color}|${size}`;
  if (!iconCache[key]) {
    iconCache[key] = L.divIcon({
      className: "forksy-dot",
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color}55, 0 2px 6px rgba(0,0,0,.35)"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }
  return iconCache[key];
}

function FitBounds({ points, padding = 40 }) {
  const map = useMap();
  const key = JSON.stringify(points);
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 14));
    else map.fitBounds(L.latLngBounds(points), { padding: [padding, padding], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}

function ClickHandler({ onClick }) {
  useMapEvents({ click: (e) => onClick?.([e.latlng.lat, e.latlng.lng]) });
  return null;
}

/**
 * Generic map.
 *  markers:  [{ id, lat, lng, color?, glyph?, kind:'pin'|'dot', title, popup(ReactNode), draggable, onDragEnd([lat,lng]), onClick }]
 *  polygons: [{ id, points:[[lat,lng]], color, label, fillOpacity }]
 *  lines:    [{ id, points, color, dashed }]
 *  fit: auto fit bounds to everything (default true when items exist)
 */
export function MapView({ markers = [], polygons = [], lines = [], height = 420, center = DEFAULT_CENTER, zoom = 12, fit = true, onClick, className = "", children }) {
  const pts = useMemo(() => {
    const p = [];
    markers.forEach((m) => m.lat != null && m.lng != null && p.push([m.lat, m.lng]));
    polygons.forEach((g) => g.points?.forEach((q) => p.push(q)));
    lines.forEach((l) => l.points?.forEach((q) => p.push(q)));
    return p;
  }, [markers, polygons, lines]);
  return (
    <div className={`radius-12 overflow-hidden border ${className}`} style={{ height }}>
      <MapContainer center={center} zoom={zoom} style={{ height: "100%", width: "100%" }} scrollWheelZoom>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {fit && pts.length > 0 && <FitBounds points={pts} />}
        {onClick && <ClickHandler onClick={onClick} />}
        {polygons.map((g) => (
          <Polygon key={g.id} positions={g.points} pathOptions={{ color: g.color || "#f95a16", fillOpacity: g.fillOpacity ?? 0.15, weight: 2 }} eventHandlers={g.onClick ? { click: g.onClick } : undefined}>
            {g.label && <Tooltip sticky>{g.label}</Tooltip>}
          </Polygon>
        ))}
        {lines.map((l) => (
          <Polyline key={l.id} positions={l.points} pathOptions={{ color: l.color || "#487fff", weight: 4, dashArray: l.dashed ? "8 8" : undefined }} />
        ))}
        {markers
          .filter((m) => m.lat != null && m.lng != null)
          .map((m) => (
            <Marker
              key={m.id}
              position={[m.lat, m.lng]}
              icon={m.kind === "dot" ? dot(m.color, m.size) : pin(m.color, m.glyph, m.size)}
              draggable={!!m.draggable}
              eventHandlers={{
                click: m.onClick,
                dragend: (e) => m.onDragEnd?.([e.target.getLatLng().lat, e.target.getLatLng().lng]),
              }}
            >
              {m.title && !m.popup && <Tooltip>{m.title}</Tooltip>}
              {m.popup && <Popup>{m.popup}</Popup>}
            </Marker>
          ))}
        {children}
      </MapContainer>
    </div>
  );
}

/** Location picker: click the map or drag the pin. value: {lat,lng} */
export function LocationPicker({ value, onChange, height = 300, center }) {
  const has = value?.lat != null && value?.lng != null;
  return (
    <MapView
      height={height}
      center={has ? [value.lat, value.lng] : center || DEFAULT_CENTER}
      zoom={has ? 15 : 12}
      fit={false}
      onClick={([lat, lng]) => onChange?.({ lat, lng })}
      markers={has ? [{ id: "p", lat: value.lat, lng: value.lng, draggable: true, onDragEnd: ([lat, lng]) => onChange?.({ lat, lng }) }] : []}
    />
  );
}

/**
 * Polygon editor: click to add vertices, drag to adjust, buttons to undo / clear.
 * value: [[lat,lng],...]   onChange(points)
 */
export function PolygonEditor({ value = [], onChange, height = 420, center, others = [] }) {
  const move = (i, p) => onChange(value.map((v, idx) => (idx === i ? p : v)));
  return (
    <div>
      <MapView
        height={height}
        center={value[0] || center || DEFAULT_CENTER}
        zoom={12}
        fit={value.length > 0 && others.length === 0}
        onClick={(p) => onChange([...value, p])}
        polygons={[
          ...others.map((o) => ({ ...o, color: "#94a3b8", fillOpacity: 0.05 })),
          ...(value.length >= 3 ? [{ id: "edit", points: value, color: "#f95a16", fillOpacity: 0.2 }] : []),
        ]}
        lines={value.length === 2 ? [{ id: "l", points: value, color: "#f95a16", dashed: true }] : []}
        markers={value.map((p, i) => ({ id: `v${i}`, lat: p[0], lng: p[1], kind: "dot", color: "#f95a16", draggable: true, onDragEnd: (np) => move(i, np), title: `Point ${i + 1}` }))}
      />
      <div className="d-flex align-items-center gap-2 mt-2">
        <span className="text-secondary-light text-sm me-auto">
          {value.length} point{value.length === 1 ? "" : "s"} — click the map to add, drag to adjust (min 3)
        </span>
        <button type="button" className="btn btn-sm btn-outline-neutral-300 text-primary-light" disabled={!value.length} onClick={() => onChange(value.slice(0, -1))}>
          Undo
        </button>
        <button type="button" className="btn btn-sm btn-outline-danger-600" disabled={!value.length} onClick={() => onChange([])}>
          Clear
        </button>
      </div>
    </div>
  );
}
