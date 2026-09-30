import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Cart, MenuCategory, MenuItem, MenuItemModifierGroup, ModifierGroup, ModifierOption, Restaurant } from '../database/entities';
import { RestaurantStatus } from '../common/enums';
import { AvailabilityService, daypartOf, zonedParts } from '../core/core.module';
import { newId, round2 } from './util';

export interface CartItemInput {
  menuItemId: string;
  quantity: number;
  modifierOptionIds?: string[];
  notes?: string;
}

type CartLine = NonNullable<Cart['items']>[number];

export interface CartIssue {
  lineId: string | null;
  menuItemId: string | null;
  code: 'ITEM_REMOVED' | 'ITEM_UNAVAILABLE' | 'NOT_SERVED_NOW' | 'MODIFIER_UNAVAILABLE' | 'RESTAURANT_UNAVAILABLE' | 'BELOW_MINIMUM';
  message: string;
}

interface ItemBundle {
  item: MenuItem;
  groups: { group: ModifierGroup; options: ModifierOption[] }[];
}

@Injectable()
export class CartService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private availability: AvailabilityService,
  ) {}

  private repo() {
    return this.ds.getRepository(Cart);
  }

  async getOrCreate(customerId: string) {
    let cart = await this.repo().findOne({ where: { customerId } });
    if (!cart) cart = await this.repo().save(this.repo().create({ customerId, restaurantId: null, items: [], promoCode: null }));
    return cart;
  }

  // ------------------------------------------------------------------ menu lookups
  async bundles(itemIds: string[]): Promise<Map<string, ItemBundle>> {
    const out = new Map<string, ItemBundle>();
    if (!itemIds.length) return out;
    const items = await this.ds.getRepository(MenuItem).find({ where: { id: In(itemIds) } });
    const links = await this.ds.getRepository(MenuItemModifierGroup).find({ where: { menuItemId: In(items.map((i) => i.id)) }, order: { sortOrder: 'ASC' } });
    const groupIds = [...new Set(links.map((l) => l.groupId))];
    const groups = groupIds.length ? await this.ds.getRepository(ModifierGroup).find({ where: { id: In(groupIds) } }) : [];
    const options = groupIds.length ? await this.ds.getRepository(ModifierOption).find({ where: { groupId: In(groupIds) } }) : [];
    for (const item of items) {
      out.set(item.id, {
        item,
        groups: links
          .filter((l) => l.menuItemId === item.id)
          .map((l) => groups.find((g) => g.id === l.groupId))
          .filter((g): g is ModifierGroup => !!g)
          .map((group) => ({ group, options: options.filter((o) => o.groupId === group.id) })),
      });
    }
    return out;
  }

  /** Strict validation used when a line is written: throws 400 with a friendly message. */
  private validateSelection(b: ItemBundle, optionIds: string[]) {
    const chosen = new Set(optionIds);
    if (chosen.size !== optionIds.length) throw new BadRequestException('Duplicate modifier options');
    const known = new Set(b.groups.flatMap((g) => g.options.map((o) => o.id)));
    for (const id of chosen) if (!known.has(id)) throw new BadRequestException('Invalid modifier option for this item');
    for (const { group, options } of b.groups) {
      const n = options.filter((o) => chosen.has(o.id)).length;
      const min = group.required ? Math.max(1, group.minSelect) : group.minSelect;
      if (n < min) throw new BadRequestException(`Choose at least ${min} option${min > 1 ? 's' : ''} for "${group.name}"`);
      if (group.maxSelect > 0 && n > group.maxSelect) throw new BadRequestException(`Choose at most ${group.maxSelect} option${group.maxSelect > 1 ? 's' : ''} for "${group.name}"`);
      for (const o of options) if (chosen.has(o.id) && !o.available) throw new BadRequestException(`"${o.name}" is currently unavailable`);
    }
  }

  private async assertRestaurantOrderable(r: Restaurant | null) {
    if (!r || r.status !== RestaurantStatus.LIVE) throw new BadRequestException('This restaurant is not accepting orders right now');
  }

  private normalise(i: { menuItemId: string; quantity: number; modifierOptionIds?: string[]; notes?: string }, lineId?: string): CartLine {
    return {
      lineId: lineId ?? newId(),
      menuItemId: i.menuItemId,
      quantity: Math.floor(i.quantity),
      modifierOptionIds: [...new Set(i.modifierOptionIds ?? [])].sort(),
      notes: i.notes?.trim() ? i.notes.trim().slice(0, 300) : undefined,
    };
  }

  private sameLine(a: CartLine, b: CartLine) {
    return a.menuItemId === b.menuItemId && JSON.stringify(a.modifierOptionIds ?? []) === JSON.stringify(b.modifierOptionIds ?? []) && (a.notes ?? '') === (b.notes ?? '');
  }

  private async prepareLine(restaurantId: string, input: CartItemInput, bundles?: Map<string, ItemBundle>) {
    if (!(input.quantity >= 1 && input.quantity <= 50)) throw new BadRequestException('Quantity must be between 1 and 50');
    const b = (bundles ?? (await this.bundles([input.menuItemId]))).get(input.menuItemId);
    if (!b || b.item.restaurantId !== restaurantId) throw new NotFoundException('Menu item not found at this restaurant');
    if (!b.item.active) throw new NotFoundException('Menu item not found at this restaurant');
    if (!b.item.available) throw new BadRequestException(`"${b.item.name}" is currently unavailable`);
    this.validateSelection(b, input.modifierOptionIds ?? []);
    return this.normalise(input);
  }

  // ------------------------------------------------------------------ writes
  async replace(customerId: string, dto: { restaurantId: string; items: CartItemInput[]; promoCode?: string | null }) {
    const r = await this.ds.getRepository(Restaurant).findOne({ where: { id: dto.restaurantId } });
    await this.assertRestaurantOrderable(r);
    const bundles = await this.bundles([...new Set(dto.items.map((i) => i.menuItemId))]);
    const lines: CartLine[] = [];
    for (const it of dto.items) {
      const line = await this.prepareLine(dto.restaurantId, it, bundles);
      const existing = lines.find((l) => this.sameLine(l, line));
      if (existing) existing.quantity = Math.min(50, existing.quantity + line.quantity);
      else lines.push(line);
    }
    const cart = await this.getOrCreate(customerId);
    cart.restaurantId = lines.length ? dto.restaurantId : null;
    cart.items = lines;
    if (dto.promoCode !== undefined) cart.promoCode = dto.promoCode?.trim().toUpperCase() || null;
    await this.repo().save(cart);
    return this.view(customerId);
  }

  async clear(customerId: string) {
    const cart = await this.getOrCreate(customerId);
    cart.items = [];
    cart.restaurantId = null;
    cart.promoCode = null;
    await this.repo().save(cart);
    return this.view(customerId);
  }

  async addItem(customerId: string, dto: CartItemInput & { restaurantId?: string; replaceCart?: boolean }) {
    const bundle = (await this.bundles([dto.menuItemId])).get(dto.menuItemId);
    if (!bundle) throw new NotFoundException('Menu item not found');
    const restaurantId = bundle.item.restaurantId;
    if (dto.restaurantId && dto.restaurantId !== restaurantId) throw new BadRequestException('Menu item does not belong to that restaurant');
    const rest = await this.ds.getRepository(Restaurant).findOne({ where: { id: restaurantId } });
    await this.assertRestaurantOrderable(rest);
    const line = await this.prepareLine(restaurantId, dto, new Map([[dto.menuItemId, bundle]]));
    const cart = await this.getOrCreate(customerId);
    if (cart.restaurantId && cart.restaurantId !== restaurantId && cart.items.length) {
      if (!dto.replaceCart) {
        const cur = await this.ds.getRepository(Restaurant).findOne({ where: { id: cart.restaurantId } });
        throw new ConflictException({
          statusCode: 409,
          code: 'CART_RESTAURANT_CONFLICT',
          message: `Your cart has items from ${cur?.name ?? 'another restaurant'}. Start a new cart for ${rest!.name}?`,
          details: { currentRestaurant: { id: cart.restaurantId, name: cur?.name ?? null, itemCount: cart.items.reduce((n, i) => n + i.quantity, 0) }, newRestaurant: { id: restaurantId, name: rest!.name } },
        });
      }
      cart.items = [];
      cart.promoCode = null;
    }
    cart.restaurantId = restaurantId;
    const existing = cart.items.find((l) => this.sameLine(l, line));
    if (existing) existing.quantity = Math.min(50, existing.quantity + line.quantity);
    else cart.items = [...cart.items, line];
    await this.repo().save(cart);
    return this.view(customerId);
  }

  async updateItem(customerId: string, lineId: string, dto: { quantity?: number; modifierOptionIds?: string[]; notes?: string }) {
    const cart = await this.getOrCreate(customerId);
    const idx = cart.items.findIndex((l) => l.lineId === lineId);
    if (idx < 0) throw new NotFoundException('Cart line not found');
    if (dto.quantity !== undefined && dto.quantity <= 0) return this.removeItem(customerId, lineId);
    const cur = cart.items[idx];
    const next = this.normalise({ menuItemId: cur.menuItemId, quantity: dto.quantity ?? cur.quantity, modifierOptionIds: dto.modifierOptionIds ?? cur.modifierOptionIds, notes: dto.notes !== undefined ? dto.notes : cur.notes }, lineId);
    await this.prepareLine(cart.restaurantId!, next);
    const items = [...cart.items];
    items[idx] = next;
    // merge with an identical line if edits made them equal
    const dup = items.findIndex((l, i) => i !== idx && this.sameLine(l, next));
    if (dup >= 0) {
      items[dup] = { ...items[dup], quantity: Math.min(50, items[dup].quantity + next.quantity) };
      items.splice(idx, 1);
    }
    cart.items = items;
    await this.repo().save(cart);
    return this.view(customerId);
  }

  async removeItem(customerId: string, lineId: string) {
    const cart = await this.getOrCreate(customerId);
    cart.items = cart.items.filter((l) => l.lineId !== lineId);
    if (!cart.items.length) {
      cart.restaurantId = null;
      cart.promoCode = null;
    }
    await this.repo().save(cart);
    return this.view(customerId);
  }

  async setPromo(customerId: string, code: string | null) {
    const cart = await this.getOrCreate(customerId);
    cart.promoCode = code?.trim().toUpperCase() || null;
    await this.repo().save(cart);
    return this.view(customerId);
  }

  // ------------------------------------------------------------------ read / validate
  /**
   * Cart with server-side validation and totals. Lines whose item vanished, went out of stock or left its daypart are
   * flagged in `issues` (and `lines[].valid = false`) instead of being dropped silently.
   */
  async view(customerId: string) {
    const cart = await this.getOrCreate(customerId);
    return this.describe(cart);
  }

  async describe(cart: Pick<Cart, 'restaurantId' | 'items' | 'promoCode'>) {
    if (!cart.restaurantId || !cart.items.length) {
      return { restaurant: null, lines: [], itemCount: 0, subtotal: 0, promoCode: cart.promoCode ?? null, issues: [] as CartIssue[], valid: true, meetsMinimum: true };
    }
    const rest = await this.ds.getRepository(Restaurant).findOne({ where: { id: cart.restaurantId } });
    const bundles = await this.bundles([...new Set(cart.items.map((i) => i.menuItemId))]);
    const tz = rest ? await this.availability.timezoneFor(rest) : 'America/Toronto';
    const now = new Date();
    const part = daypartOf(zonedParts(now, tz).minutes);
    const cats = rest ? await this.ds.getRepository(MenuCategory).find({ where: { restaurantId: rest.id } }) : [];
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const issues: CartIssue[] = [];
    const status = rest ? await this.availability.status(rest, now) : { open: false, reason: 'NOT_LIVE' as string | undefined };
    if (!rest || rest.status !== RestaurantStatus.LIVE) issues.push({ lineId: null, menuItemId: null, code: 'RESTAURANT_UNAVAILABLE', message: 'This restaurant is not accepting orders right now' });

    let subtotal = 0;
    const lines = cart.items.map((l) => {
      const b = bundles.get(l.menuItemId);
      const lineId = l.lineId ?? null;
      if (!b || !b.item.active || b.item.restaurantId !== cart.restaurantId) {
        issues.push({ lineId, menuItemId: l.menuItemId, code: 'ITEM_REMOVED', message: 'An item in your cart is no longer on the menu' });
        return { lineId, menuItemId: l.menuItemId, name: b?.item.name ?? 'Unavailable item', imageUrl: null as string | null, quantity: l.quantity, unitPrice: 0, lineTotal: 0, modifiers: [] as { groupName: string; optionId: string; name: string; priceDelta: number }[], notes: l.notes ?? null, valid: false, problem: 'ITEM_REMOVED' as string | null };
      }
      let problem: string | null = null;
      const mods: { groupName: string; optionId: string; name: string; priceDelta: number }[] = [];
      for (const oid of l.modifierOptionIds ?? []) {
        const g = b.groups.find((x) => x.options.some((o) => o.id === oid));
        const o = g?.options.find((x) => x.id === oid);
        if (!g || !o) {
          problem = 'MODIFIER_UNAVAILABLE';
          issues.push({ lineId, menuItemId: b.item.id, code: 'MODIFIER_UNAVAILABLE', message: `An option for "${b.item.name}" is no longer offered` });
          continue;
        }
        if (!o.available) {
          problem = 'MODIFIER_UNAVAILABLE';
          issues.push({ lineId, menuItemId: b.item.id, code: 'MODIFIER_UNAVAILABLE', message: `"${o.name}" is currently unavailable` });
        }
        mods.push({ groupName: g.group.name, optionId: o.id, name: o.name, priceDelta: o.priceDelta });
      }
      if (!b.item.available) {
        problem = 'ITEM_UNAVAILABLE';
        issues.push({ lineId, menuItemId: b.item.id, code: 'ITEM_UNAVAILABLE', message: `"${b.item.name}" is currently unavailable` });
      } else {
        const cat = b.item.categoryId ? catMap.get(b.item.categoryId) : undefined;
        const blocked = (!!b.item.dayparts?.length && !b.item.dayparts.includes(part)) || (!!cat?.dayparts?.length && !cat.dayparts.includes(part));
        if (blocked) {
          problem = problem ?? 'NOT_SERVED_NOW';
          issues.push({ lineId, menuItemId: b.item.id, code: 'NOT_SERVED_NOW', message: `"${b.item.name}" is not served at this time of day` });
        }
      }
      const unitPrice = round2(b.item.price + mods.reduce((s, m) => s + m.priceDelta, 0));
      const lineTotal = round2(unitPrice * l.quantity);
      subtotal += lineTotal;
      return { lineId, menuItemId: b.item.id, name: b.item.name, imageUrl: b.item.imageUrl, quantity: l.quantity, unitPrice, lineTotal, modifiers: mods, notes: l.notes ?? null, valid: !problem, problem };
    });
    subtotal = round2(subtotal);
    const minimum = rest?.minimumOrder ?? 0;
    const meetsMinimum = subtotal >= minimum;
    if (!meetsMinimum) issues.push({ lineId: null, menuItemId: null, code: 'BELOW_MINIMUM', message: `Minimum order is $${minimum.toFixed(2)}` });
    return {
      restaurant: rest
        ? {
            id: rest.id,
            slug: rest.slug,
            name: rest.name,
            logoUrl: rest.logoUrl,
            minimumOrder: minimum,
            isOpen: status.open,
            closedReason: status.open ? null : status.reason ?? null,
            opensAt: status.open ? null : (status as any).opensAt ?? null,
            canSchedule: rest.scheduledEnabled,
            deliveryEnabled: rest.deliveryEnabled,
            pickupEnabled: rest.pickupEnabled,
          }
        : null,
      lines,
      itemCount: cart.items.reduce((n, i) => n + i.quantity, 0),
      subtotal,
      promoCode: cart.promoCode ?? null,
      issues,
      valid: lines.every((l) => l.valid) && !issues.some((i) => i.code === 'RESTAURANT_UNAVAILABLE'),
      meetsMinimum,
    };
  }
}
