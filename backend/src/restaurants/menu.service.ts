import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import {
  KitchenStation,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Restaurant,
  TaxClass,
} from '../database/entities';
import { DayPart } from '../common/enums';
import { CategoryDto, ItemDto, ModifierGroupDto, ModifierOptionDto } from './dto';
import { nextRestockTime } from './restaurants.util';
import { AvailabilityService } from '../core/core.module';

const DAYPARTS = Object.values(DayPart) as string[];

/** minimal RFC4180 CSV parser / writer */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export { csvCell } from '../common/csv';
import { csvCell } from '../common/csv';
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export const MENU_CSV_HEADER = [
  'category',
  'name',
  'description',
  'price',
  'pickup_price',
  'tax_class',
  'calories',
  'allergens',
  'dietary_tags',
  'dayparts',
  'prep_time_min',
  'station',
  'available',
  'image_url',
  'popular',
  'modifier_groups',
];

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(MenuCategory) private categories: Repository<MenuCategory>,
    @InjectRepository(MenuItem) private items: Repository<MenuItem>,
    @InjectRepository(ModifierGroup) private groups: Repository<ModifierGroup>,
    @InjectRepository(ModifierOption) private options: Repository<ModifierOption>,
    @InjectRepository(MenuItemModifierGroup) private links: Repository<MenuItemModifierGroup>,
    @InjectRepository(KitchenStation) private stations: Repository<KitchenStation>,
    @InjectRepository(TaxClass) private taxClasses: Repository<TaxClass>,
    private availability: AvailabilityService,
  ) {}

  // ------------------------------------------------------------------ read
  async tree(restaurantId: string, includeInactive = true) {
    const [cats, items, groups, links, stations] = await Promise.all([
      this.categories.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.items.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.groups.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.links.find({ where: { menuItemId: In((await this.items.find({ where: { restaurantId }, select: ['id'] })).map((i) => i.id).concat(['00000000-0000-0000-0000-000000000000'])) } }),
      this.stations.find({ where: { restaurantId }, order: { sortOrder: 'ASC' } }),
    ]);
    const opts = groups.length ? await this.options.find({ where: { groupId: In(groups.map((g) => g.id)) }, order: { sortOrder: 'ASC', name: 'ASC' } }) : [];
    const groupView = groups.map((g) => ({ ...g, options: opts.filter((o) => o.groupId === g.id) }));
    const byId = new Map(groupView.map((g) => [g.id, g]));
    const stationById = new Map(stations.map((s) => [s.id, s]));
    const itemView = (i: MenuItem) => ({
      ...i,
      stationName: i.stationId ? stationById.get(i.stationId)?.name ?? null : null,
      modifierGroups: links
        .filter((l) => l.menuItemId === i.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((l) => byId.get(l.groupId))
        .filter(Boolean),
    });
    const visible = includeInactive ? items : items.filter((i) => i.active);
    const views = visible.map(itemView);
    return {
      categories: cats.map((c) => ({ ...c, items: views.filter((i) => i.categoryId === c.id) })),
      uncategorized: views.filter((i) => !i.categoryId || !cats.some((c) => c.id === i.categoryId)),
      combos: views.filter((i) => i.isCombo),
      modifierGroups: groupView,
      stations,
      counts: { items: items.length, unavailable: items.filter((i) => !i.available).length, categories: cats.length, modifierGroups: groups.length },
    };
  }

  // ------------------------------------------------------------------ categories
  async createCategory(restaurantId: string, dto: CategoryDto) {
    this.checkDayparts(dto.dayparts);
    const max = await this.categories.maximum('sortOrder', { restaurantId });
    return this.categories.save(
      this.categories.create({ restaurantId, name: dto.name, description: dto.description ?? null, sortOrder: dto.sortOrder ?? (max ?? -1) + 1, active: dto.active ?? true, dayparts: (dto.dayparts as DayPart[]) ?? [] }),
    );
  }

  async updateCategory(restaurantId: string, id: string, dto: Partial<CategoryDto>) {
    const c = await this.categories.findOne({ where: { id, restaurantId } });
    if (!c) throw new NotFoundException('Category not found');
    if (dto.dayparts) this.checkDayparts(dto.dayparts);
    if (dto.name !== undefined) c.name = dto.name;
    if (dto.description !== undefined) c.description = dto.description;
    if (dto.sortOrder !== undefined) c.sortOrder = dto.sortOrder;
    if (dto.active !== undefined) c.active = dto.active;
    if (dto.dayparts) c.dayparts = dto.dayparts as DayPart[];
    return this.categories.save(c);
  }

  async deleteCategory(restaurantId: string, id: string, moveItemsTo?: string) {
    const c = await this.categories.findOne({ where: { id, restaurantId } });
    if (!c) throw new NotFoundException('Category not found');
    const n = await this.items.count({ where: { categoryId: id } });
    if (n && !moveItemsTo) throw new ConflictException(`Category still has ${n} item(s); pass moveItemsTo=<categoryId> or delete/move the items first`);
    if (n) {
      if (!(await this.categories.exist({ where: { id: moveItemsTo!, restaurantId } }))) throw new NotFoundException('Target category not found');
      await this.items.update({ categoryId: id }, { categoryId: moveItemsTo! });
    }
    await this.categories.delete(id);
    return { ok: true };
  }

  async reorderCategories(restaurantId: string, ids: string[]) {
    await Promise.all(ids.map((id, i) => this.categories.update({ id, restaurantId }, { sortOrder: i })));
    return { ok: true };
  }

  // ------------------------------------------------------------------ items
  private checkDayparts(d?: string[]) {
    for (const x of d ?? []) if (!DAYPARTS.includes(x)) throw new BadRequestException(`Unknown daypart ${x} (use ${DAYPARTS.join(', ')})`);
  }

  private async validateItem(restaurantId: string, dto: Partial<ItemDto>) {
    this.checkDayparts(dto.dayparts);
    if (dto.categoryId && !(await this.categories.exist({ where: { id: dto.categoryId, restaurantId } }))) throw new BadRequestException('Unknown categoryId');
    if (dto.stationId && !(await this.stations.exist({ where: { id: dto.stationId, restaurantId } }))) throw new BadRequestException('Unknown stationId');
    if (dto.taxClassCode && !(await this.taxClasses.exist({ where: { code: dto.taxClassCode } }))) throw new BadRequestException(`Unknown tax class ${dto.taxClassCode}`);
    if (dto.comboItems?.length) {
      const ids = dto.comboItems.map((c) => c.menuItemId);
      const found = await this.items.count({ where: { id: In(ids), restaurantId } });
      if (found !== new Set(ids).size) throw new BadRequestException('comboItems reference unknown items');
    }
    if (dto.groupIds?.length) {
      const found = await this.groups.count({ where: { id: In(dto.groupIds), restaurantId } });
      if (found !== new Set(dto.groupIds).size) throw new BadRequestException('groupIds reference unknown modifier groups');
    }
  }

  async createItem(restaurantId: string, dto: ItemDto) {
    await this.validateItem(restaurantId, dto);
    const max = await this.items.maximum('sortOrder', { restaurantId, categoryId: dto.categoryId ?? IsNull() });
    const item = await this.items.save(
      this.items.create({
        restaurantId,
        categoryId: dto.categoryId ?? null,
        name: dto.name,
        description: dto.description ?? null,
        imageUrl: dto.imageUrl ?? null,
        price: dto.price,
        pickupPrice: dto.pickupPrice ?? null,
        taxClassCode: dto.taxClassCode ?? 'HST_ON',
        calories: dto.calories ?? null,
        allergens: dto.allergens ?? [],
        dietaryTags: dto.dietaryTags ?? [],
        sortOrder: dto.sortOrder ?? (max ?? -1) + 1,
        available: dto.available ?? true,
        dayparts: (dto.dayparts as DayPart[]) ?? [],
        isCombo: dto.isCombo ?? !!dto.comboItems?.length,
        comboItems: dto.comboItems ?? [],
        stationId: dto.stationId ?? null,
        prepTimeMin: dto.prepTimeMin ?? null,
        isPopular: dto.isPopular ?? false,
        active: dto.active ?? true,
      }),
    );
    if (dto.groupIds) await this.setItemGroups(restaurantId, item.id, dto.groupIds);
    return this.getItem(restaurantId, item.id);
  }

  async getItem(restaurantId: string, id: string) {
    const item = await this.items.findOne({ where: { id, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    const links = await this.links.find({ where: { menuItemId: id }, order: { sortOrder: 'ASC' } });
    const groups = links.length ? await this.groups.find({ where: { id: In(links.map((l) => l.groupId)) } }) : [];
    const opts = groups.length ? await this.options.find({ where: { groupId: In(groups.map((g) => g.id)) }, order: { sortOrder: 'ASC' } }) : [];
    return {
      ...item,
      modifierGroups: links.map((l) => groups.find((g) => g.id === l.groupId)).filter(Boolean).map((g) => ({ ...g!, options: opts.filter((o) => o.groupId === g!.id) })),
    };
  }

  async updateItem(restaurantId: string, id: string, dto: Partial<ItemDto>) {
    const item = await this.items.findOne({ where: { id, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    await this.validateItem(restaurantId, dto);
    const { groupIds, ...rest } = dto;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (item as any)[k] = v;
    if (dto.comboItems && dto.isCombo === undefined) item.isCombo = dto.comboItems.length > 0;
    if (dto.available === true) item.restockAt = null;
    await this.items.save(item);
    if (groupIds) await this.setItemGroups(restaurantId, id, groupIds);
    return this.getItem(restaurantId, id);
  }

  async deleteItem(restaurantId: string, id: string) {
    const item = await this.items.findOne({ where: { id, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    // order history keeps its own snapshot (order_items.name), so a hard delete is safe; combos referencing it are cleaned
    await this.links.delete({ menuItemId: id });
    const combos = await this.items.find({ where: { restaurantId, isCombo: true } });
    for (const c of combos) {
      const next = c.comboItems.filter((x) => x.menuItemId !== id);
      if (next.length !== c.comboItems.length) await this.items.update(c.id, { comboItems: next });
    }
    await this.items.delete(id);
    return { ok: true };
  }

  async reorderItems(restaurantId: string, ids: string[]) {
    await Promise.all(ids.map((id, i) => this.items.update({ id, restaurantId }, { sortOrder: i })));
    return { ok: true };
  }

  async setItemGroups(restaurantId: string, itemId: string, groupIds: string[]) {
    const item = await this.items.findOne({ where: { id: itemId, restaurantId }, select: ['id'] });
    if (!item) throw new NotFoundException('Menu item not found');
    if (groupIds.length && (await this.groups.count({ where: { id: In(groupIds), restaurantId } })) !== new Set(groupIds).size) throw new BadRequestException('Unknown modifier group');
    await this.links.delete({ menuItemId: itemId });
    if (groupIds.length) await this.links.insert([...new Set(groupIds)].map((groupId, i) => ({ menuItemId: itemId, groupId, sortOrder: i })));
    return this.getItem(restaurantId, itemId);
  }

  // ------------------------------------------------------------------ 86 / availability
  private restockDate(opts: { restockAt?: string | null; untilTomorrow?: boolean; hours?: number }, tz: string): Date | null {
    if (opts.restockAt) {
      const d = new Date(opts.restockAt);
      if (isNaN(d.getTime())) throw new BadRequestException('restockAt must be an ISO date');
      return d;
    }
    if (opts.hours) return new Date(Date.now() + opts.hours * 3600_000);
    if (opts.untilTomorrow === false) return null; // stays out until manually restocked
    return nextRestockTime(new Date(), tz); // default: next day 04:00
  }

  /** One-tap 86: unavailable until restockAt (default next 04:00 local). */
  async eightySix(restaurantId: string, itemId: string, opts: { restockAt?: string | null; untilTomorrow?: boolean; hours?: number } = {}) {
    const item = await this.items.findOne({ where: { id: itemId, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    item.available = false;
    item.restockAt = this.restockDate(opts, await this.availability.timezoneFor(r!));
    return this.items.save(item);
  }

  async restockItem(restaurantId: string, itemId: string) {
    const item = await this.items.findOne({ where: { id: itemId, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    item.available = true;
    item.restockAt = null;
    return this.items.save(item);
  }

  private async optionFor(restaurantId: string, optionId: string) {
    const opt = await this.options.findOne({ where: { id: optionId } });
    if (!opt || !(await this.groups.exist({ where: { id: opt.groupId, restaurantId } }))) throw new NotFoundException('Modifier option not found');
    return opt;
  }

  async eightySixOption(restaurantId: string, optionId: string, opts: { restockAt?: string | null; untilTomorrow?: boolean; hours?: number } = {}) {
    const opt = await this.optionFor(restaurantId, optionId);
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    opt.available = false;
    opt.restockAt = this.restockDate(opts, await this.availability.timezoneFor(r!));
    return this.options.save(opt);
  }

  async restockOption(restaurantId: string, optionId: string) {
    const opt = await this.optionFor(restaurantId, optionId);
    opt.available = true;
    opt.restockAt = null;
    return this.options.save(opt);
  }

  /** Scheduler: auto-restock everything whose restockAt has passed. Returns counts. */
  async restockDue(now = new Date()) {
    const a = await this.items.update({ available: false, restockAt: LessThanOrEqual(now) }, { available: true, restockAt: null });
    const b = await this.options.update({ available: false, restockAt: LessThanOrEqual(now) }, { available: true, restockAt: null });
    return { items: a.affected ?? 0, options: b.affected ?? 0 };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepRestock() {
    await this.restockDue().catch(() => undefined);
  }

  // ------------------------------------------------------------------ modifier groups & options
  private checkGroup(dto: Partial<ModifierGroupDto>, cur?: ModifierGroup) {
    const min = dto.minSelect ?? cur?.minSelect ?? 0;
    const max = dto.maxSelect ?? cur?.maxSelect ?? 1;
    if (min < 0 || max < 1 || min > max) throw new BadRequestException('Invalid min/max selection (need 0 <= min <= max, max >= 1)');
    if ((dto.required ?? cur?.required) && min < 1) dto.minSelect = 1;
  }

  async createGroup(restaurantId: string, dto: ModifierGroupDto) {
    this.checkGroup(dto);
    const max = await this.groups.maximum('sortOrder', { restaurantId });
    const g = await this.groups.save(
      this.groups.create({
        restaurantId,
        name: dto.name,
        required: dto.required ?? false,
        minSelect: dto.minSelect ?? (dto.required ? 1 : 0),
        maxSelect: dto.maxSelect ?? 1,
        sortOrder: dto.sortOrder ?? (max ?? -1) + 1,
      }),
    );
    for (const [i, o] of (dto.options ?? []).entries()) await this.createOption(restaurantId, g.id, { ...o, sortOrder: o.sortOrder ?? i });
    if (dto.itemIds?.length) for (const itemId of dto.itemIds) await this.attachGroup(restaurantId, itemId, g.id);
    return this.getGroup(restaurantId, g.id);
  }

  async getGroup(restaurantId: string, id: string) {
    const g = await this.groups.findOne({ where: { id, restaurantId } });
    if (!g) throw new NotFoundException('Modifier group not found');
    const options = await this.options.find({ where: { groupId: id }, order: { sortOrder: 'ASC', name: 'ASC' } });
    const itemIds = (await this.links.find({ where: { groupId: id } })).map((l) => l.menuItemId);
    return { ...g, options, itemIds };
  }

  async updateGroup(restaurantId: string, id: string, dto: Partial<ModifierGroupDto>) {
    const g = await this.groups.findOne({ where: { id, restaurantId } });
    if (!g) throw new NotFoundException('Modifier group not found');
    this.checkGroup(dto, g);
    for (const k of ['name', 'required', 'minSelect', 'maxSelect', 'sortOrder'] as const) if (dto[k] !== undefined) (g as any)[k] = dto[k];
    await this.groups.save(g);
    if (dto.itemIds) {
      await this.links.delete({ groupId: id });
      for (const itemId of new Set(dto.itemIds)) await this.attachGroup(restaurantId, itemId, id);
    }
    return this.getGroup(restaurantId, id);
  }

  async deleteGroup(restaurantId: string, id: string) {
    const g = await this.groups.findOne({ where: { id, restaurantId } });
    if (!g) throw new NotFoundException('Modifier group not found');
    await this.links.delete({ groupId: id });
    await this.options.delete({ groupId: id });
    await this.groups.delete(id);
    return { ok: true };
  }

  async attachGroup(restaurantId: string, itemId: string, groupId: string) {
    if (!(await this.items.exist({ where: { id: itemId, restaurantId } })) || !(await this.groups.exist({ where: { id: groupId, restaurantId } }))) throw new NotFoundException('Item or group not found');
    if (await this.links.exist({ where: { menuItemId: itemId, groupId } })) return;
    const max = await this.links.maximum('sortOrder', { menuItemId: itemId });
    await this.links.insert({ menuItemId: itemId, groupId, sortOrder: (max ?? -1) + 1 });
  }

  async detachGroup(restaurantId: string, itemId: string, groupId: string) {
    if (!(await this.items.exist({ where: { id: itemId, restaurantId } }))) throw new NotFoundException('Item not found');
    await this.links.delete({ menuItemId: itemId, groupId });
    return { ok: true };
  }

  async createOption(restaurantId: string, groupId: string, dto: ModifierOptionDto) {
    if (!(await this.groups.exist({ where: { id: groupId, restaurantId } }))) throw new NotFoundException('Modifier group not found');
    const max = await this.options.maximum('sortOrder', { groupId });
    return this.options.save(
      this.options.create({ groupId, name: dto.name, priceDelta: dto.priceDelta ?? 0, isDefault: dto.isDefault ?? false, available: dto.available ?? true, sortOrder: dto.sortOrder ?? (max ?? -1) + 1 }),
    );
  }

  async updateOption(restaurantId: string, optionId: string, dto: Partial<ModifierOptionDto>) {
    const o = await this.optionFor(restaurantId, optionId);
    for (const k of ['name', 'priceDelta', 'isDefault', 'available', 'sortOrder'] as const) if (dto[k] !== undefined) (o as any)[k] = dto[k];
    if (dto.available === true) o.restockAt = null;
    return this.options.save(o);
  }

  async deleteOption(restaurantId: string, optionId: string) {
    await this.optionFor(restaurantId, optionId);
    await this.options.delete(optionId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ prep targets
  prepTargets(restaurantId: string) {
    return this.items.find({ where: { restaurantId, active: true }, select: ['id', 'name', 'prepTimeMin', 'stationId', 'categoryId'], order: { name: 'ASC' } });
  }

  async setPrepTargets(restaurantId: string, targets: { itemId: string; prepTimeMin: number | null }[]) {
    for (const t of targets) await this.items.update({ id: t.itemId, restaurantId }, { prepTimeMin: t.prepTimeMin });
    return { ok: true, updated: targets.length };
  }

  // ------------------------------------------------------------------ CSV export / import
  private groupsToCell(groups: (ModifierGroup & { options: ModifierOption[] })[]) {
    return groups
      .map((g) => `${g.name}(${g.required ? 'req' : 'opt'},${g.minSelect},${g.maxSelect})=${g.options.map((o) => `${o.name}+${o.priceDelta}`).join('|')}`)
      .join(';');
  }

  private parseGroupsCell(cell: string) {
    const out: { name: string; required: boolean; min: number; max: number; options: { name: string; price: number }[] }[] = [];
    for (const part of cell.split(';').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^(.+?)\((req|opt),(\d+),(\d+)\)=(.*)$/i);
      if (!m) throw new BadRequestException(`Bad modifier_groups cell: "${part}" (expected Name(req|opt,min,max)=Opt+price|Opt+price)`);
      out.push({
        name: m[1].trim(),
        required: m[2].toLowerCase() === 'req',
        min: +m[3],
        max: Math.max(1, +m[4]),
        options: m[5]
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const i = s.lastIndexOf('+');
            return i > 0 ? { name: s.slice(0, i).trim(), price: parseFloat(s.slice(i + 1)) || 0 } : { name: s, price: 0 };
          }),
      });
    }
    return out;
  }

  async exportCsv(restaurantId: string): Promise<string> {
    const t = await this.tree(restaurantId, true);
    const catName = new Map(t.categories.map((c) => [c.id, c.name]));
    const all = [...t.categories.flatMap((c) => c.items), ...t.uncategorized];
    const rows: unknown[][] = [MENU_CSV_HEADER];
    for (const i of all) {
      rows.push([
        i.categoryId ? catName.get(i.categoryId) ?? '' : '',
        i.name,
        i.description ?? '',
        i.price,
        i.pickupPrice ?? '',
        i.taxClassCode ?? '',
        i.calories ?? '',
        (i.allergens ?? []).join('|'),
        (i.dietaryTags ?? []).join('|'),
        (i.dayparts ?? []).join('|'),
        i.prepTimeMin ?? '',
        i.stationName ?? '',
        i.available ? 'true' : 'false',
        i.imageUrl ?? '',
        i.isPopular ? 'true' : 'false',
        this.groupsToCell(i.modifierGroups as any),
      ]);
    }
    return toCsv(rows);
  }

  /** mode=merge (default): upsert by category+name; mode=replace: wipe the existing menu first. */
  async importCsv(restaurantId: string, csv: string, mode: 'merge' | 'replace' = 'merge') {
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new BadRequestException('CSV needs a header row and at least one item row');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    if (!header.includes('name') || !header.includes('price')) throw new BadRequestException(`CSV header must contain at least name and price (expected: ${MENU_CSV_HEADER.join(',')})`);
    const col = (r: string[], k: string) => (r[header.indexOf(k)] ?? '').trim();
    const errors: { row: number; error: string }[] = [];
    const parsed: any[] = [];
    rows.slice(1).forEach((r, idx) => {
      try {
        const price = parseFloat(col(r, 'price'));
        if (!col(r, 'name')) throw new Error('name is required');
        if (!isFinite(price) || price < 0) throw new Error('price must be a number >= 0');
        const list = (k: string) => col(r, k).split(/[|;]/).map((s) => s.trim()).filter(Boolean);
        const dayparts = list('dayparts').map((d) => d.toUpperCase());
        for (const d of dayparts) if (!DAYPARTS.includes(d)) throw new Error(`unknown daypart ${d}`);
        parsed.push({
          category: col(r, 'category'),
          name: col(r, 'name'),
          description: col(r, 'description') || null,
          price,
          pickupPrice: col(r, 'pickup_price') ? parseFloat(col(r, 'pickup_price')) : null,
          taxClassCode: col(r, 'tax_class') || 'HST_ON',
          calories: col(r, 'calories') ? parseInt(col(r, 'calories'), 10) : null,
          allergens: list('allergens'),
          dietaryTags: list('dietary_tags'),
          dayparts,
          prepTimeMin: col(r, 'prep_time_min') ? parseInt(col(r, 'prep_time_min'), 10) : null,
          station: col(r, 'station'),
          available: col(r, 'available') ? !/^(false|0|no)$/i.test(col(r, 'available')) : true,
          imageUrl: col(r, 'image_url') || null,
          isPopular: /^(true|1|yes)$/i.test(col(r, 'popular')),
          groups: this.parseGroupsCell(col(r, 'modifier_groups')),
        });
      } catch (e: any) {
        errors.push({ row: idx + 2, error: e.message ?? String(e) });
      }
    });
    if (errors.length) throw new BadRequestException({ message: 'CSV has errors - nothing was imported', details: errors });

    if (mode === 'replace') {
      const ids = (await this.items.find({ where: { restaurantId }, select: ['id'] })).map((i) => i.id);
      if (ids.length) await this.links.delete({ menuItemId: In(ids) });
      await this.items.delete({ restaurantId });
      const gs = (await this.groups.find({ where: { restaurantId }, select: ['id'] })).map((g) => g.id);
      if (gs.length) await this.options.delete({ groupId: In(gs) });
      await this.groups.delete({ restaurantId });
      await this.categories.delete({ restaurantId });
    }
    const cats = new Map((await this.categories.find({ where: { restaurantId } })).map((c) => [c.name.toLowerCase(), c]));
    const stations = new Map((await this.stations.find({ where: { restaurantId } })).map((s) => [s.name.toLowerCase(), s]));
    const groupCache = new Map((await this.groups.find({ where: { restaurantId } })).map((g) => [g.name.toLowerCase(), g]));
    let created = 0;
    let updated = 0;
    for (const p of parsed) {
      let cat: MenuCategory | undefined;
      if (p.category) {
        cat = cats.get(p.category.toLowerCase());
        if (!cat) {
          cat = await this.createCategory(restaurantId, { name: p.category });
          cats.set(p.category.toLowerCase(), cat);
        }
      }
      let station: KitchenStation | undefined;
      if (p.station) {
        station = stations.get(p.station.toLowerCase());
        if (!station) {
          station = await this.stations.save(this.stations.create({ restaurantId, name: p.station, sortOrder: stations.size }));
          stations.set(p.station.toLowerCase(), station);
        }
      }
      const existing = await this.items.findOne({ where: { restaurantId, name: p.name, categoryId: cat?.id ?? IsNull() } });
      const fields: Partial<MenuItem> = {
        categoryId: cat?.id ?? null,
        description: p.description,
        price: p.price,
        pickupPrice: p.pickupPrice,
        taxClassCode: p.taxClassCode,
        calories: p.calories,
        allergens: p.allergens,
        dietaryTags: p.dietaryTags,
        dayparts: p.dayparts,
        prepTimeMin: p.prepTimeMin,
        stationId: station?.id ?? null,
        available: p.available,
        imageUrl: p.imageUrl,
        isPopular: p.isPopular,
      };
      let item: MenuItem;
      if (existing) {
        Object.assign(existing, fields);
        item = await this.items.save(existing);
        updated++;
      } else {
        item = await this.items.save(this.items.create({ restaurantId, name: p.name, sortOrder: created + updated, ...fields }));
        created++;
      }
      const gids: string[] = [];
      for (const gdef of p.groups) {
        let g = groupCache.get(gdef.name.toLowerCase());
        if (!g) {
          const made = await this.createGroup(restaurantId, {
            name: gdef.name,
            required: gdef.required,
            minSelect: gdef.min,
            maxSelect: gdef.max,
            options: gdef.options.map((o: any) => ({ name: o.name, priceDelta: o.price })),
          });
          g = made as ModifierGroup;
          groupCache.set(gdef.name.toLowerCase(), g);
        }
        gids.push(g.id);
      }
      if (gids.length || !existing) await this.setItemGroups(restaurantId, item.id, gids);
    }
    return { ok: true, created, updated, total: parsed.length, mode };
  }
}
