import React, { useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Card } from "../../ui";
import { API_URL, http } from "../../lib/api";
import { safeImgUrl } from "../../lib/safe";
import { messageOf } from "./shared";

/** the picture fields of the branding section: they are changed here (upload), not in the text form */
export const PICTURE_FIELDS = ["logoUrl", "logoDarkUrl", "logoSquareUrl", "faviconUrl", "appleTouchIconUrl", "pwaIcon192Url", "pwaIcon512Url", "ogImageUrl", "twitterImageUrl"];
const API_ORIGIN = API_URL.replace(/\/api\/v\d+\/?$/, "");
const src = (u) => (u ? safeImgUrl(String(u).startsWith("/") ? `${API_ORIGIN}${u}` : u) : undefined);

const kb = (n) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : `${Math.round(n / 1024)} KB`);
const rule = (s) => [s.square ? "square" : s.ratio ? "wide, about 1.91 : 1 (1200 x 630 is best)" : "any shape", `at least ${s.minWidth} x ${s.minHeight} px`, s.formats.map((f) => f.toUpperCase()).join(" / "), `up to ${kb(s.maxBytes)}`].join(", ");
const WHERE = { logo: "Header and emails", "logo-dark": "Dark backgrounds", "logo-square": "Assistant and chat avatar, structured data", favicon: "Browser tab", "apple-touch-icon": "iPhone home screen", "pwa-icon-192": "Installed web app", "pwa-icon-512": "Installed web app, splash screen", "og-image": "Link previews (Facebook, WhatsApp, LinkedIn)", "twitter-image": "Link previews on X" };

/** The logo, favicon, app icons and share pictures: one tile each, with what it is for, the rules and Upload / Remove. Each upload is checked by the server. */
export function Branding({ options, value, canEdit, onChange }) {
  const slots = options?.brandingSlots ?? [];
  return (
    <Card title="Pictures" subtitle="Upload a picture: the server checks its type and size (a favicon must be square, a share picture must be wide) and puts it on the website at once." className="mb-24">
      <div className="row g-3" data-testid="slots">
        {slots.map((s) => (
          <div key={s.slot} className="col-12 col-md-6 col-xl-4">
            <SlotTile slot={s} url={value?.[s.field]} canEdit={canEdit} onChange={onChange} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function SlotTile({ slot, url, canEdit, onChange }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await http.post(`/admin/site/branding/${slot.slot}`, fd, { headers: { "Content-Type": "multipart/form-data" } });
      toast.success(`${slot.label} uploaded (${r.width} x ${r.height} px)`);
      onChange(r.branding, r.version);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const r = await http.del(`/admin/site/branding/${slot.slot}`);
      toast.success(`${slot.label} removed`);
      onChange(r.branding, r.version);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBusy(false);
    }
  };
  const dark = slot.slot === "logo-dark";
  return (
    <div className="border radius-8 p-16 h-100 d-flex flex-column" data-testid={`slot-${slot.slot}`}>
      <div className="fw-semibold">{slot.label}</div>
      <div className="text-secondary-light text-xs mb-12">{WHERE[slot.slot]}</div>
      <div className="radius-8 d-flex align-items-center justify-content-center mb-12" style={{ height: 120, background: dark ? "#1f2937" : "repeating-conic-gradient(#f3f4f6 0% 25%, #fff 0% 50%) 50% / 16px 16px" }}>
        {url ? <img src={src(url)} alt={slot.label} style={{ maxWidth: "100%", maxHeight: 112, objectFit: "contain" }} data-testid="slot-image" /> : <span className={`text-sm ${dark ? "text-white-50" : "text-secondary-light"}`}><Icon icon="solar:gallery-add-outline" className="text-2xl d-block mx-auto mb-1" />Not set</span>}
      </div>
      <div className="text-secondary-light text-xs mb-12">{rule(slot)}</div>
      {canEdit && (
        <div className="d-flex gap-2 mt-auto">
          <label className={`btn btn-sm btn-outline-primary-600 radius-8 mb-0 ${busy ? "disabled" : ""}`}>
            {busy ? "Working..." : url ? "Replace" : "Upload"}
            <input ref={ref} type="file" accept={slot.formats.map((f) => (f === "jpg" ? "image/jpeg" : `image/${f}`)).join(",")} hidden disabled={busy} onChange={pick} data-testid={`upload-${slot.slot}`} />
          </label>
          {url && <button type="button" className="btn btn-sm text-danger-600 p-0 px-2" disabled={busy} onClick={remove} data-testid={`remove-${slot.slot}`}>Remove</button>}
        </div>
      )}
    </div>
  );
}
