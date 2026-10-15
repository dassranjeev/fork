import React from "react";
import { coldChain, isWeighed, perUnitPrice, stepPriceOf, stepText, stockBadge } from "../lib/retail";
import { money } from "../lib/sfApi";
import { itemDisabled } from "./ItemDialog";
import { Pic, Ri } from "./ui";

/** One product of a grocery / convenience / specialty store: picture, name, brand and pack size, price (per kg for weighed products), stock, age limit, cold chain. */
export default function ProductCard({ item, closed, onOpen, onQuick }) {
  const disabled = itemDisabled(item, closed);
  const quick = !disabled && !(item.modifierGroups || []).length;
  const weighed = isWeighed(item);
  const stock = stockBadge(item);
  const cold = coldChain(item);
  const price = weighed ? perUnitPrice(item) : money(item.price);
  const detail = [item.brand, !weighed && item.packSize].filter(Boolean).join(" - ");
  return (
    <div className={`sf-product ${disabled ? "is-disabled" : ""}`} data-testid="product-card" data-item-id={item.id}>
      <button type="button" className="sf-product-main" onClick={() => onOpen(item)} aria-label={`${item.name}, ${price}${stock ? `, ${stock.text}` : ""}${item.ageRestricted ? `, ${item.minAge} and over` : ""}`}>
        <Pic src={item.imageUrl} name={item.name} className="sf-product-img" />
        <div className="sf-item-name">{item.name}</div>
        {detail && <div className="sf-small sf-muted">{detail}</div>}
        <div className="sf-item-price" data-testid="product-price">{price}</div>
        {weighed && <div className="sf-small sf-muted" data-testid="product-step">{money(stepPriceOf(item))} per {stepText(item)}</div>}
        <div className="sf-tags">
          {stock && <span className={`sf-tag sf-tag-${stock.tone}`} data-testid="product-stock">{stock.text}</span>}
          {item.ageRestricted && (
            <span className="sf-tag sf-tag-warn" data-testid="product-age" title="ID is checked at your door">
              {item.minAge}+
            </span>
          )}
          {cold && (
            <span className="sf-tag sf-tag-cold" data-testid="product-cold">
              <Ri name={cold.icon} /> {cold.text}
            </span>
          )}
          {(item.dietaryTags || []).slice(0, 2).map((t) => (
            <span key={t} className="sf-tag sf-tag-ok">{t}</span>
          ))}
        </div>
      </button>
      <button
        type="button"
        className="sf-addbtn"
        disabled={disabled}
        onClick={() => (quick ? onQuick(item) : onOpen(item))}
        aria-label={disabled ? `${item.name} is not available` : `Add ${item.name}`}
        data-testid="product-quick-add"
      >
        <Ri name={disabled ? "forbid-line" : "add-line"} />
      </button>
    </div>
  );
}
