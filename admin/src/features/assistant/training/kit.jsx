import React, { useMemo } from "react";
import { http } from "../../../lib/api";

/**
 * Tiny API client for ONE bot's training endpoints. `base` is e.g. "/restaurant/assistant/training" (portal, params {restaurantId}),
 * "/admin/assistant/training/restaurants/<id>" or "/admin/assistant/training/central".
 */
export function useTrainingApi(base, params) {
  const key = JSON.stringify(params || {});
  return useMemo(() => {
    const cfg = params ? { params } : undefined;
    return {
      base,
      get: (p, q) => http.get(base + p, { ...(params || {}), ...(q || {}) }),
      post: (p, body) => http.post(base + p, body ?? {}, cfg),
      patch: (p, body) => http.patch(base + p, body ?? {}, cfg),
      del: (p) => http.del(base + p, cfg),
      download: (p, name) => http.download(base + p, params, name),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key]);
}

/** Readable form of an API error: { message, fields: { "answer": "...", "questions[0]": "..." }, list, code } */
export function problem(err) {
  const d = err?.response?.data;
  const list = Array.isArray(d?.details) ? d.details.filter((x) => x && typeof x === "object" && x.message) : [];
  const fields = {};
  list.forEach((i) => {
    if (!fields[i.field]) fields[i.field] = i.message;
  });
  let message = "Something went wrong";
  if (d?.message) message = Array.isArray(d.message) ? d.message.join(", ") : d.message;
  else if (err?.code === "ERR_NETWORK") message = "Cannot reach the server. Is the API running?";
  else if (err?.message) message = err.message;
  return { message, fields, list, code: d?.code, status: err?.response?.status };
}

export const pct = (v) => (v === null || v === undefined ? "n/a" : `${v}%`);

/** read a text file picked by the user (client side: no upload endpoint needed) */
export function readTextFile(file, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("No file"));
    if (file.size > maxBytes) return reject(new Error("That file is too large (max 1 MB). Split it into smaller files."));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Could not read the file"));
    fr.onload = () => resolve(String(fr.result || ""));
    fr.readAsText(file);
  });
}

export function saveJson(data, filename) {
  const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/** per-field messages under an editor (the ones the server could not tie to a visible input) */
export function ProblemList({ list, skip = [] }) {
  const rest = (list || []).filter((i) => !skip.includes(i.field));
  if (!rest.length) return null;
  return (
    <ul className="text-sm mb-12 ps-20" role="alert">
      {rest.map((i, n) => (
        <li key={n} className={i.severity === "block" ? "text-danger-main" : "text-warning-main"}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}
