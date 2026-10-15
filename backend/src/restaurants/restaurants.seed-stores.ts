import type { Def, Item, Menu } from './restaurants.seed';
import { StoreType } from '../common/enums';

/**
 * Demo grocery / specialty stores (merchants 27+): a supermarket, an Asian market and a halal butcher. They show every retail feature of docs/store-types.md:
 * departments, SKUs and barcodes, products sold by weight (price per kg, ordered in steps), stock levels (one product low, one sold out), cold chain
 * (chilled / frozen), age-restricted products (beer and wine, 19+) and Ontario tax classes (basic groceries are ZERO_RATED, snacks / drinks / household HST_ON).
 */
const Z = 'ZERO_RATED';

/** deterministic 12-digit UPC-like barcode from a key: the same product key gives the same barcode in every store */
const barcode = (key: string) => {
  let h = 7;
  for (const c of key) h = (h * 131 + c.charCodeAt(0)) % 99_999_999_999;
  return String(h).padStart(11, '0') + '5';
};

interface P {
  /** product key: SKU of the store (and the barcode seed unless `code` is given) */
  sku: string;
  code?: string;
  brand?: string;
  pack?: string;
  desc?: string;
  tags?: string[];
  allergens?: string[];
  tax?: string;
  temp?: 'AMBIENT' | 'CHILLED' | 'FROZEN';
  stock?: number;
  low?: number;
  minAge?: number;
  max?: number;
  /** sold by weight: the price is per `unit`, the customer orders steps of `step` */
  weigh?: { unit: 'KG' | 'LB'; step: number };
}

const p = (name: string, price: number, o: P): Item => [
  name,
  price,
  o.desc ?? '',
  o.tags ?? [],
  o.allergens ?? [],
  o.tax,
  {
    sku: o.sku,
    barcode: barcode(o.code ?? o.sku),
    brand: o.brand ?? null,
    packSize: o.pack ?? (o.weigh ? `per ${o.weigh.unit.toLowerCase()}` : null),
    sellBy: o.weigh ? 'WEIGHT' : 'UNIT',
    weightUnit: o.weigh?.unit ?? 'KG',
    stepSize: o.weigh?.step ?? 1,
    trackStock: o.stock !== undefined,
    stockQty: o.stock ?? null,
    lowStockThreshold: o.low ?? null,
    minAge: o.minAge ?? 0,
    maxPerOrder: o.max ?? null,
    temperature: o.temp ?? 'AMBIENT',
  },
];

export const STORE_MENUS: Record<string, Menu> = {
  supermarket: {
    categories: [
      {
        name: 'Produce',
        station: '',
        items: [
          p('Bananas', 2.18, { sku: 'FB-P-001', tags: ['vegan'], tax: Z, weigh: { unit: 'KG', step: 0.5 }, stock: 60, low: 10 }),
          p('Gala Apples', 4.39, { sku: 'FB-P-002', tags: ['vegan'], tax: Z, weigh: { unit: 'KG', step: 0.5 }, stock: 40, low: 8 }),
          p('Roma Tomatoes', 3.99, { sku: 'FB-P-003', tags: ['vegan'], tax: Z, weigh: { unit: 'KG', step: 0.5 }, stock: 25, low: 5 }),
          p('Hass Avocado', 1.69, { sku: 'FB-P-004', tags: ['vegan'], tax: Z, pack: 'each', stock: 48, low: 10 }),
          p('Baby Spinach', 4.49, { sku: 'FB-P-005', brand: 'Fresh Basket', pack: '312 g', tags: ['vegan'], tax: Z, temp: 'CHILLED', stock: 30, low: 6 }),
          p('Yellow Onions', 3.49, { sku: 'FB-P-006', pack: '3 lb bag', tags: ['vegan'], tax: Z, stock: 50 }),
          p('Russet Potatoes', 6.99, { sku: 'FB-P-007', pack: '10 lb bag', tags: ['vegan'], tax: Z, stock: 35 }),
          p('Carrots', 2.99, { sku: 'FB-P-008', pack: '2 lb bag', tags: ['vegan'], tax: Z, stock: 45 }),
        ],
      },
      {
        name: 'Dairy & Eggs',
        station: '',
        items: [
          p('Milk 2% (2 L)', 5.49, { sku: 'FB-D-001', code: 'MILK2PCT2L', brand: 'Neilson', pack: '2 L', tags: ['vegetarian'], allergens: ['dairy'], tax: Z, temp: 'CHILLED', stock: 40, low: 8 }),
          p('Large White Eggs', 4.79, { sku: 'FB-D-002', code: 'EGGS12', brand: 'Gray Ridge', pack: '12 count', tags: ['vegetarian'], allergens: ['egg'], tax: Z, temp: 'CHILLED', stock: 3, low: 5, max: 4 }),
          p('Salted Butter', 6.49, { sku: 'FB-D-003', brand: 'Gay Lea', pack: '454 g', tags: ['vegetarian'], allergens: ['dairy'], tax: Z, temp: 'CHILLED', stock: 25 }),
          p('Old Cheddar', 7.99, { sku: 'FB-D-004', brand: 'Black Diamond', pack: '400 g', tags: ['vegetarian'], allergens: ['dairy'], tax: Z, temp: 'CHILLED', stock: 20 }),
          p('Greek Yogurt', 5.99, { sku: 'FB-D-005', brand: 'Oikos', pack: '750 g', tags: ['vegetarian'], allergens: ['dairy'], tax: Z, temp: 'CHILLED', stock: 28 }),
        ],
      },
      {
        name: 'Bakery',
        station: '',
        items: [
          p('Sourdough Loaf', 5.49, { sku: 'FB-B-001', brand: 'Fresh Basket', pack: '675 g', tags: ['vegan'], allergens: ['gluten'], tax: Z, stock: 0 }),
          p('Whole Wheat Bread', 3.79, { sku: 'FB-B-002', brand: 'Dempster\'s', pack: '675 g', tags: ['vegan'], allergens: ['gluten'], tax: Z, stock: 30 }),
          p('Plain Bagels', 3.99, { sku: 'FB-B-003', pack: '6 count', tags: ['vegan'], allergens: ['gluten'], tax: Z, stock: 22 }),
          p('Butter Croissants', 5.49, { sku: 'FB-B-004', pack: '6 count', tags: ['vegetarian'], allergens: ['gluten', 'dairy', 'egg'], tax: Z, stock: 12, low: 4 }),
        ],
      },
      {
        name: 'Meat & Seafood',
        station: '',
        items: [
          p('Chicken Breast, boneless', 11.99, { sku: 'FB-M-001', tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.5 }, stock: 30, low: 5 }),
          p('Lean Ground Beef', 12.99, { sku: 'FB-M-002', tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.5 }, stock: 25, low: 5 }),
          p('Atlantic Salmon Fillet', 24.99, { sku: 'FB-M-003', tax: Z, temp: 'CHILLED', allergens: ['fish'], weigh: { unit: 'KG', step: 0.25 }, stock: 12, low: 3 }),
          p('Frozen Raw Shrimp', 13.99, { sku: 'FB-M-004', pack: '400 g', tax: Z, temp: 'FROZEN', allergens: ['shellfish'], stock: 18 }),
        ],
      },
      {
        name: 'Frozen',
        station: '',
        items: [
          p('Frozen Mixed Vegetables', 3.99, { sku: 'FB-F-001', brand: 'Green Giant', pack: '750 g', tags: ['vegan'], tax: Z, temp: 'FROZEN', stock: 40 }),
          p('Vanilla Ice Cream', 6.49, { sku: 'FB-F-002', brand: 'Chapman\'s', pack: '2 L', tags: ['vegetarian'], allergens: ['dairy'], temp: 'FROZEN', stock: 20 }),
          p('Frozen Margherita Pizza', 7.99, { sku: 'FB-F-003', brand: 'Delissio', pack: '400 g', tags: ['vegetarian'], allergens: ['gluten', 'dairy'], tax: Z, temp: 'FROZEN', stock: 24 }),
        ],
      },
      {
        name: 'Pantry',
        station: '',
        items: [
          p('Basmati Rice', 9.99, { sku: 'FB-PA-001', code: 'BASMATI2KG', brand: 'Tilda', pack: '2 kg', tags: ['vegan'], tax: Z, stock: 40 }),
          p('Spaghetti', 2.49, { sku: 'FB-PA-002', brand: 'Barilla', pack: '900 g', tags: ['vegan'], allergens: ['gluten'], tax: Z, stock: 60 }),
          p('Whole Peeled Tomatoes', 2.29, { sku: 'FB-PA-003', brand: 'San Marzano', pack: '796 ml', tags: ['vegan'], tax: Z, stock: 70 }),
          p('Extra Virgin Olive Oil', 12.99, { sku: 'FB-PA-004', brand: 'Bertolli', pack: '1 L', tags: ['vegan'], tax: Z, stock: 25 }),
          p('Peanut Butter', 5.99, { sku: 'FB-PA-005', brand: 'Kraft', pack: '500 g', tags: ['vegan'], allergens: ['peanuts'], tax: Z, stock: 32 }),
          p('Corn Flakes', 5.49, { sku: 'FB-PA-006', brand: 'Kellogg\'s', pack: '725 g', tags: ['vegan'], allergens: ['gluten'], tax: Z, stock: 28 }),
        ],
      },
      {
        name: 'Snacks & Candy',
        station: '',
        items: [
          p('Classic Potato Chips', 4.99, { sku: 'FB-S-001', brand: 'Lay\'s', pack: '235 g', tags: ['vegan'], stock: 50 }),
          p('Chocolate Sandwich Cookies', 4.49, { sku: 'FB-S-002', brand: 'Oreo', pack: '270 g', tags: ['vegetarian'], allergens: ['gluten'], stock: 44 }),
          p('Milk Chocolate Bar', 2.29, { sku: 'FB-S-003', brand: 'Cadbury', pack: '100 g', tags: ['vegetarian'], allergens: ['dairy'], stock: 80 }),
        ],
      },
      {
        name: 'Beverages',
        station: '',
        items: [
          p('Coca-Cola', 8.99, { sku: 'FB-BV-001', brand: 'Coca-Cola', pack: '12 x 355 ml', stock: 36, low: 6 }),
          p('Sparkling Water', 6.49, { sku: 'FB-BV-002', brand: 'Perrier', pack: '8 x 330 ml', stock: 30 }),
          p('Spring Water', 4.99, { sku: 'FB-BV-003', brand: 'Nestle', pack: '24 x 500 ml', stock: 30 }),
        ],
      },
      {
        name: 'Beer, Wine & Cider',
        station: '',
        items: [
          p('Lager', 14.95, { sku: 'FB-A-001', brand: 'Steam Whistle', pack: '6 x 355 ml', minAge: 19, stock: 24, low: 6, max: 4, desc: 'Ontario pilsner. 19+: ID is checked at your door.' }),
          p('Pinot Grigio', 15.95, { sku: 'FB-A-002', brand: 'Fuzion', pack: '750 ml', minAge: 19, stock: 12, max: 6, desc: 'Dry white wine. 19+: ID is checked at your door.' }),
          p('Hazy IPA', 13.5, { sku: 'FB-A-003', brand: 'Collective Arts', pack: '4 x 473 ml', minAge: 19, stock: 18, max: 4, desc: 'Craft ale. 19+: ID is checked at your door.' }),
        ],
      },
      {
        name: 'Household',
        station: '',
        items: [
          p('Paper Towels', 9.99, { sku: 'FB-H-001', brand: 'Bounty', pack: '6 rolls', stock: 35 }),
          p('Dish Soap', 3.99, { sku: 'FB-H-002', brand: 'Dawn', pack: '532 ml', stock: 40 }),
          p('Laundry Detergent', 14.99, { sku: 'FB-H-003', brand: 'Tide', pack: '2.04 L', stock: 22 }),
        ],
      },
    ],
    groups: [],
  },

  asianmarket: {
    categories: [
      {
        name: 'Fresh Produce',
        station: '',
        items: [
          p('Bok Choy', 3.99, { sku: 'SA-P-001', tags: ['vegan'], tax: Z, weigh: { unit: 'KG', step: 0.5 }, stock: 20, low: 4 }),
          p('Napa Cabbage', 2.49, { sku: 'SA-P-002', tags: ['vegan'], tax: Z, weigh: { unit: 'KG', step: 0.5 }, stock: 30 }),
          p('Fresh Ginger', 5.99, { sku: 'SA-P-003', tags: ['vegan'], tax: Z, weigh: { unit: 'KG', step: 0.25 }, stock: 8, low: 2 }),
        ],
      },
      {
        name: 'Rice, Noodles & Pantry',
        station: '',
        items: [
          p('Jasmine Rice', 18.99, { sku: 'SA-R-001', brand: 'Golden Phoenix', pack: '5 kg', tags: ['vegan'], tax: Z, stock: 25 }),
          p('Basmati Rice', 9.99, { sku: 'SA-R-002', code: 'BASMATI2KG', brand: 'Tilda', pack: '2 kg', tags: ['vegan'], tax: Z, stock: 12 }),
          p('Instant Ramen', 6.49, { sku: 'SA-R-003', brand: 'Shin', pack: '5 x 120 g', tags: ['vegan'], allergens: ['gluten', 'soy'], stock: 60 }),
          p('Soy Sauce', 5.99, { sku: 'SA-R-004', brand: 'Kikkoman', pack: '1 L', tags: ['vegan'], allergens: ['soy', 'gluten'], tax: Z, stock: 30 }),
          p('Sriracha Hot Sauce', 4.49, { sku: 'SA-R-005', brand: 'Huy Fong', pack: '481 ml', tags: ['vegan'], tax: Z, stock: 35 }),
          p('Roasted Seaweed Snack', 2.99, { sku: 'SA-R-006', brand: 'Gim', pack: '5 g x 12', tags: ['vegan'], stock: 50 }),
        ],
      },
      {
        name: 'Chilled & Frozen',
        station: '',
        items: [
          p('Kimchi', 7.49, { sku: 'SA-C-001', brand: 'Jongga', pack: '500 g', tags: ['vegan'], allergens: ['fish'], tax: Z, temp: 'CHILLED', stock: 15, low: 4 }),
          p('Firm Tofu', 2.79, { sku: 'SA-C-002', brand: 'House Foods', pack: '400 g', tags: ['vegan'], allergens: ['soy'], tax: Z, temp: 'CHILLED', stock: 30 }),
          p('Pork & Chive Dumplings', 9.99, { sku: 'SA-C-003', brand: 'Bibigo', pack: '800 g', allergens: ['gluten', 'soy'], tax: Z, temp: 'FROZEN', stock: 20 }),
        ],
      },
      {
        name: 'Drinks',
        station: '',
        items: [
          p('Green Tea Bags', 6.99, { sku: 'SA-D-001', brand: 'Ito En', pack: '40 bags', tags: ['vegan'], tax: Z, stock: 25 }),
          p('Soju', 12.5, { sku: 'SA-D-002', brand: 'Jinro', pack: '360 ml', minAge: 19, stock: 20, max: 4, desc: '19+: ID is checked at your door.' }),
        ],
      },
    ],
    groups: [],
  },

  butcher: {
    categories: [
      {
        name: 'Beef & Lamb',
        station: '',
        items: [
          p('Beef Ribeye Steak', 39.99, { sku: 'PC-B-001', tags: ['halal'], tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.25 }, stock: 15, low: 3 }),
          p('Lean Ground Beef', 13.99, { sku: 'PC-B-002', tags: ['halal'], tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.5 }, stock: 30, low: 5 }),
          p('Lamb Leg, bone-in', 21.99, { sku: 'PC-B-003', tags: ['halal'], tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.5 }, stock: 20 }),
          p('Beef Sausages', 8.99, { sku: 'PC-B-004', pack: '6 count', tags: ['halal'], tax: Z, temp: 'CHILLED', stock: 24 }),
        ],
      },
      {
        name: 'Chicken',
        station: '',
        items: [
          p('Chicken Breast, boneless', 12.99, { sku: 'PC-C-001', tags: ['halal'], tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.5 }, stock: 40, low: 6 }),
          p('Chicken Wings', 8.99, { sku: 'PC-C-002', tags: ['halal'], tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.5 }, stock: 25 }),
          p('Marinated Chicken Kebab', 14.99, { sku: 'PC-C-003', tags: ['halal'], tax: Z, temp: 'CHILLED', weigh: { unit: 'KG', step: 0.5 }, stock: 15 }),
        ],
      },
      {
        name: 'Spices & Extras',
        station: '',
        items: [
          p('BBQ Spice Rub', 5.49, { sku: 'PC-S-001', pack: '120 g', tags: ['vegan'], stock: 40 }),
          p('Charcoal Briquettes', 11.99, { sku: 'PC-S-002', pack: '3.6 kg', stock: 18 }),
        ],
      },
    ],
    groups: [],
  },
};

const BRAMPTON_ZONES = ['Downtown Brampton', 'Bramalea', 'Springdale', 'Heart Lake'];

const RAW_STORE_DEFS: Def[] = [
  { name: 'Fresh Basket Supermarket', merchant: 27, cuisines: ['Grocery', 'Supermarket'], menu: 'supermarket', storeType: StoreType.GROCERY, zone: 'City Centre', dLat: 0.003, dLng: -0.002, street: '200 Rathburn Rd W', postal: 'L5B 4C1', price: 2, tier: 'Grocery & retail', prep: 30, hours: 'conv', minOrder: 20, featured: true },
  { name: 'Seoul Asian Market', merchant: 28, cuisines: ['Asian Grocery', 'Grocery'], menu: 'asianmarket', storeType: StoreType.GROCERY, zone: 'Bramalea', dLat: -0.002, dLng: 0.003, street: '2 Gillingham Dr', postal: 'L6X 5A5', price: 1, tier: 'Grocery & retail', prep: 25, hours: 'std', minOrder: 15 },
  { name: 'Prime Cut Halal Butcher', merchant: 29, cuisines: ['Butcher', 'Halal'], menu: 'butcher', storeType: StoreType.SPECIALTY, zone: 'Port Credit', dLat: 0.002, dLng: -0.003, street: '40 Lakeshore Rd W', postal: 'L5H 1E7', price: 2, tier: 'Grocery & retail', prep: 20, hours: 'std', minOrder: 15 },
];

export const STORE_DEFS: Def[] = RAW_STORE_DEFS.map((d) => ({ ...d, city: BRAMPTON_ZONES.includes(d.zone) ? 'Brampton' : 'Mississauga' }));
