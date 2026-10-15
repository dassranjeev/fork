import React, { useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { API_URL, errorMessage, http } from "../../lib/api";
import { safeImgUrl } from "../../lib/safe";

/** The most photos an item can have besides the featured one (the API refuses more). */
export const MAX_GALLERY = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const API_ORIGIN = API_URL.replace(/\/api\/v\d+\/?$/, "");

/** An uploaded photo is stored with its full address; an older relative "/uploads/..." one is served by the API host. */
export const photoSrc = (u) => (u ? safeImgUrl(String(u).startsWith("/") ? `${API_ORIGIN}${u}` : u) : undefined);

/** Small square preview for lists: the featured photo, or a camera mark when the item has none. A "+N" badge says how many more photos it has. */
export function PhotoThumb({ item, size = 44 }) {
  const src = photoSrc(item?.imageUrl);
  const more = item?.galleryUrls?.length || 0;
  return (
    <span className="position-relative d-inline-flex flex-shrink-0" style={{ width: size, height: size }} data-testid="photo-thumb" data-has-photo={src ? "1" : "0"}>
      {src ? (
        <img src={src} alt="" className="radius-8 object-fit-cover" style={{ width: size, height: size }} loading="lazy" />
      ) : (
        <span className="radius-8 bg-neutral-100 text-secondary-light d-inline-flex align-items-center justify-content-center" style={{ width: size, height: size }} title="No photo yet">
          <Icon icon="solar:camera-outline" />
        </span>
      )}
      {more > 0 && (
        <span className="position-absolute bottom-0 end-0 badge bg-dark text-white radius-4" style={{ fontSize: 10, padding: "1px 4px" }} title={`${more} more photo${more === 1 ? "" : "s"}`}>
          +{more}
        </span>
      )}
    </span>
  );
}

/**
 * Photos of an item: ONE featured photo (shown on cards, in the item dialog and in the cart) and a gallery of up to 8 more (the customer swipes through
 * them in the item dialog). Files go to POST /uploads one by one; the item then carries their addresses (imageUrl, galleryUrls).
 *   value    { imageUrl: string|null, galleryUrls: string[] }
 *   onChange called with the new value
 */
export default function ItemPhotos({ value, onChange, disabled = false }) {
  const featuredRef = useRef(null);
  const galleryRef = useRef(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const featured = value?.imageUrl || null;
  const gallery = value?.galleryUrls || [];
  const room = (featured ? 0 : 1) + (MAX_GALLERY - gallery.length);

  const emit = (imageUrl, galleryUrls) => onChange({ imageUrl: imageUrl || null, galleryUrls });

  /** Upload the picked files and put them where there is room: the featured spot first, then the gallery. */
  const addFiles = async (list) => {
    const files = Array.from(list || []);
    if (!files.length || disabled) return;
    const ok = [];
    for (const f of files) {
      if (!TYPES.includes(f.type)) toast.error(`${f.name}: photos must be JPG, PNG, WebP or GIF`);
      else if (f.size > MAX_BYTES) toast.error(`${f.name} is too large (8 MB at most)`);
      else ok.push(f);
    }
    if (ok.length > room) toast.info(`There is room for ${room} more photo${room === 1 ? "" : "s"}: the first ${room} are added`);
    const take = ok.slice(0, Math.max(room, 0));
    if (!take.length) return;
    setBusy(take.length);
    let imageUrl = featured;
    const next = [...gallery];
    try {
      for (const f of take) {
        const saved = await http.upload(f);
        if (!imageUrl) imageUrl = saved.url;
        else if (next.length < MAX_GALLERY) next.push(saved.url);
        setBusy((n) => Math.max(0, n - 1));
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(0);
      emit(imageUrl, next);
      if (featuredRef.current) featuredRef.current.value = "";
      if (galleryRef.current) galleryRef.current.value = "";
    }
  };

  const replaceFeatured = async (list) => {
    const f = Array.from(list || [])[0];
    if (!f || disabled) return;
    if (!TYPES.includes(f.type)) return toast.error("Photos must be JPG, PNG, WebP or GIF");
    if (f.size > MAX_BYTES) return toast.error("That photo is too large (8 MB at most)");
    setBusy(1);
    try {
      const saved = await http.upload(f);
      emit(saved.url, gallery);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(0);
      if (featuredRef.current) featuredRef.current.value = "";
    }
  };

  const removeFeatured = () => {
    // the next photo of the gallery steps up, so the item keeps a picture
    const [first, ...rest] = gallery;
    emit(first || null, rest);
  };
  const makeFeatured = (i) => {
    const next = gallery.filter((_, k) => k !== i);
    if (featured) next.splice(i, 0, featured); // the old featured photo takes its place in the gallery
    emit(gallery[i], next);
  };
  const removeAt = (i) => emit(featured, gallery.filter((_, k) => k !== i));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= gallery.length) return;
    const next = [...gallery];
    [next[i], next[j]] = [next[j], next[i]];
    emit(featured, next);
  };

  const iconBtn = "btn btn-sm bg-white border radius-4 p-0 d-inline-flex align-items-center justify-content-center";
  return (
    <div
      className={`border radius-8 p-16 mb-16 ${over ? "border-primary-600 bg-primary-50" : ""}`}
      data-testid="item-photos"
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        addFiles(e.dataTransfer?.files);
      }}
    >
      <div className="d-flex justify-content-between align-items-baseline mb-12">
        <div className="fw-semibold">Photos</div>
        <div className="text-secondary-light text-xs">
          {busy > 0 ? `Uploading ${busy}…` : "JPG, PNG, WebP or GIF, up to 8 MB each. You can drop photos here."}
        </div>
      </div>
      <div className="d-flex flex-wrap gap-3 align-items-start">
        <div style={{ width: 150 }}>
          <div className="position-relative radius-8 overflow-hidden border bg-neutral-100 d-flex align-items-center justify-content-center" style={{ width: 150, height: 150 }} data-testid="photo-featured">
            {featured ? (
              <img src={photoSrc(featured)} alt="Featured" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <span className="text-secondary-light text-center text-sm px-2">
                <Icon icon="solar:camera-add-outline" className="text-2xl d-block mx-auto mb-1" />
                No featured photo
              </span>
            )}
            {featured && <span className="position-absolute top-0 start-0 m-1 badge bg-primary-600 text-white radius-4">Featured</span>}
          </div>
          <div className="d-flex gap-2 mt-8">
            <label className={`btn btn-outline-primary-600 btn-sm radius-8 mb-0 flex-grow-1 ${disabled || busy ? "disabled" : ""}`} data-testid="photo-featured-button">
              {featured ? "Replace" : "Add featured photo"}
              <input ref={featuredRef} type="file" accept={TYPES.join(",")} hidden disabled={disabled || busy > 0} onChange={(e) => (featured ? replaceFeatured(e.target.files) : addFiles(e.target.files))} data-testid="photo-featured-input" />
            </label>
            {featured && (
              <button type="button" className="btn btn-sm text-danger-600 p-0 px-1" disabled={disabled} onClick={removeFeatured} data-testid="photo-featured-remove" title="Remove the featured photo">
                Remove
              </button>
            )}
          </div>
        </div>

        <div className="flex-grow-1" style={{ minWidth: 260 }}>
          <div className="text-secondary-light text-xs mb-8">
            Gallery ({gallery.length}/{MAX_GALLERY}): customers swipe through these in the item window
          </div>
          <div className="d-flex flex-wrap gap-2" data-testid="photo-gallery">
            {gallery.map((u, i) => (
              <div key={u} className="position-relative radius-8 overflow-hidden border" style={{ width: 96, height: 96 }} data-testid="photo-gallery-item">
                <img src={photoSrc(u)} alt={`Gallery ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                {!disabled && (
                  <div className="position-absolute bottom-0 start-0 end-0 d-flex justify-content-between p-1" style={{ background: "linear-gradient(transparent, rgba(0,0,0,.55))" }}>
                    <button type="button" className={iconBtn} style={{ width: 22, height: 22 }} onClick={() => move(i, -1)} disabled={i === 0} title="Move earlier" aria-label="Move earlier">
                      <Icon icon="solar:alt-arrow-left-outline" />
                    </button>
                    <button type="button" className={iconBtn} style={{ width: 22, height: 22 }} onClick={() => makeFeatured(i)} title="Make this the featured photo" aria-label="Make featured" data-testid="photo-make-featured">
                      <Icon icon="solar:star-outline" />
                    </button>
                    <button type="button" className={iconBtn} style={{ width: 22, height: 22 }} onClick={() => move(i, 1)} disabled={i === gallery.length - 1} title="Move later" aria-label="Move later">
                      <Icon icon="solar:alt-arrow-right-outline" />
                    </button>
                  </div>
                )}
                {!disabled && (
                  <button type="button" className={`${iconBtn} position-absolute top-0 end-0 m-1 text-danger-600`} style={{ width: 22, height: 22 }} onClick={() => removeAt(i)} title="Remove this photo" aria-label="Remove photo" data-testid="photo-remove">
                    <Icon icon="solar:close-circle-outline" />
                  </button>
                )}
              </div>
            ))}
            {gallery.length < MAX_GALLERY && (
              <label
                className={`radius-8 border border-dashed d-flex flex-column align-items-center justify-content-center text-secondary-light text-xs text-center mb-0 ${disabled || busy ? "opacity-50" : "cursor-pointer"}`}
                style={{ width: 96, height: 96, cursor: disabled || busy ? "default" : "pointer" }}
                data-testid="photo-add"
              >
                <Icon icon="solar:gallery-add-outline" className="text-2xl" />
                Add photos
                <input ref={galleryRef} type="file" accept={TYPES.join(",")} multiple hidden disabled={disabled || busy > 0} onChange={(e) => addFiles(e.target.files)} data-testid="photo-add-input" />
              </label>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
