import React, { useEffect, useState } from "react";
import { Pic, Ri } from "./ui";

/**
 * The photos of an item in its dialog: the featured photo first, then the gallery. One photo shows as before; with several there are
 * previous / next buttons (also the arrow keys), a row of small pictures to jump to one, and a counter.
 */
export default function PhotoGallery({ photos, name }) {
  const [i, setI] = useState(0);
  const key = photos.join("|");
  useEffect(() => setI(0), [key]);
  const n = photos.length;
  if (!n) return null;
  const go = (d) => setI((x) => (x + d + n) % n);
  const onKey = (e) => {
    if (n < 2) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    }
  };
  return (
    <div className="sf-gallery" data-testid="item-gallery" data-count={n} onKeyDown={onKey}>
      <div className="sf-gallery-stage">
        <Pic key={photos[i]} src={photos[i]} name={name} className="sf-item-hero sf-gallery-hero" />
        {n > 1 && (
          <>
            <button type="button" className="sf-gallery-nav prev" onClick={() => go(-1)} aria-label="Previous photo" data-testid="gallery-prev">
              <Ri name="arrow-left-s-line" />
            </button>
            <button type="button" className="sf-gallery-nav next" onClick={() => go(1)} aria-label="Next photo" data-testid="gallery-next">
              <Ri name="arrow-right-s-line" />
            </button>
            <span className="sf-gallery-count" aria-live="polite" data-testid="gallery-count">
              {i + 1} / {n}
            </span>
          </>
        )}
      </div>
      {n > 1 && (
        <div className="sf-gallery-thumbs" role="group" aria-label="Photos">
          {photos.map((p, k) => (
            <button key={p} type="button" className={`sf-gallery-thumb ${k === i ? "on" : ""}`} onClick={() => setI(k)} aria-label={`Photo ${k + 1} of ${n}`} aria-current={k === i ? "true" : undefined} data-testid="gallery-thumb">
              <Pic src={p} name={name} className="sf-gallery-thumb-img" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
