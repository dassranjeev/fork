import axios from "axios";
import { toast } from "react-toastify";

export const API_URL = process.env.REACT_APP_API_URL || "http://localhost:4000/api/v1";
export const WS_URL = process.env.REACT_APP_WS_URL || "http://localhost:4000";

const ACCESS = "forksy.access";
const REFRESH = "forksy.refresh";

export const tokens = {
  get access() {
    return localStorage.getItem(ACCESS);
  },
  get refresh() {
    return localStorage.getItem(REFRESH);
  },
  set({ accessToken, refreshToken }) {
    if (accessToken) localStorage.setItem(ACCESS, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH, refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  },
};

const api = axios.create({ baseURL: API_URL, timeout: 30000 });

api.interceptors.request.use((config) => {
  if (!config.headers.Authorization && tokens.access) {
    config.headers.Authorization = `Bearer ${tokens.access}`;
  }
  return config;
});

let refreshing = null;

async function refreshTokens() {
  if (!tokens.refresh) throw new Error("no refresh token");
  if (!refreshing) {
    refreshing = axios
      .post(`${API_URL}/auth/refresh`, { refreshToken: tokens.refresh })
      .then((r) => {
        tokens.set(r.data);
        return r.data.accessToken;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config || {};
    const status = error.response?.status;
    const isAuthCall = /\/auth\/(login|refresh|2fa\/verify|otp)/.test(original.url || "");
    if (status === 401 && !original._retry && !isAuthCall && tokens.refresh) {
      original._retry = true;
      try {
        const token = await refreshTokens();
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch (e) {
        tokens.clear();
        window.dispatchEvent(new Event("forksy:logout"));
      }
    } else if (status === 401 && !isAuthCall) {
      tokens.clear();
      window.dispatchEvent(new Event("forksy:logout"));
    }
    return Promise.reject(error);
  }
);

/** Human readable message from an axios error. */
export function errorMessage(err) {
  const d = err?.response?.data;
  if (d) {
    if (Array.isArray(d.details) && d.details.length) return d.details.join(", ");
    if (Array.isArray(d.message)) return d.message.join(", ");
    if (d.message) return d.message;
  }
  if (err?.code === "ERR_NETWORK") return "Cannot reach the server. Is the API running?";
  return err?.message || "Something went wrong";
}

/** Convenience wrappers returning response.data. */
export const http = {
  get: (url, params, config) => api.get(url, { params: clean(params), ...config }).then((r) => r.data),
  post: (url, body, config) => api.post(url, body, config).then((r) => r.data),
  put: (url, body, config) => api.put(url, body, config).then((r) => r.data),
  patch: (url, body, config) => api.patch(url, body, config).then((r) => r.data),
  del: (url, config) => api.delete(url, config).then((r) => r.data),
  /** download a file (CSV/XLSX) through the authenticated client */
  async download(url, params, filename) {
    const res = await api.get(url, { params: clean(params), responseType: "blob" });
    const cd = res.headers["content-disposition"] || "";
    const m = /filename="?([^";]+)"?/.exec(cd);
    const name = filename || (m && m[1]) || "download";
    const href = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  },
  /** upload one file to POST /uploads -> { url } */
  async upload(file) {
    const fd = new FormData();
    fd.append("file", file);
    return api.post("/uploads", fd, { headers: { "Content-Type": "multipart/form-data" } }).then((r) => r.data);
  },
};

/** Drop undefined / empty-string params so filters do not send `?status=`. */
export function clean(params) {
  if (!params) return params;
  const out = {};
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    out[k] = v;
  });
  return out;
}

/** Run an async action with a toast on failure/success. Returns result or undefined on error. */
export async function act(fn, { success, error = true } = {}) {
  try {
    const r = await fn();
    if (success) toast.success(success);
    return r;
  } catch (e) {
    if (error) toast.error(errorMessage(e));
    return undefined;
  }
}

export default api;
