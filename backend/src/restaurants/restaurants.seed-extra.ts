import type { Def, Group, Menu } from './restaurants.seed';
import { RestaurantServiceMode } from '../common/enums';

/**
 * Extra demo restaurants + convenience stores for Brampton and Mississauga (merchants 13+).
 * Kept in its own file; wired up by seedRestaurantsExtra() in restaurants.seed.ts.
 * Convenience items carry a tax class: ZERO_RATED for basic groceries, HST_ON (default) otherwise.
 */
const Z = 'ZERO_RATED';
const spice = (applies: string[]): Group => ({ name: 'Spice Level', required: true, min: 1, max: 1, options: [['Mild', 0], ['Medium', 0], ['Hot', 0]], appliesTo: applies });

export const EXTRA_MENUS: Record<string, Menu> = {
  punjabi: {
    categories: [
      { name: 'Curries', station: 'Curry', items: [['Butter Chicken', 17, 'Tandoori chicken in creamy tomato gravy', [], ['dairy', 'nuts']], ['Dal Makhani', 14, 'Slow-simmered black lentils, butter, cream', ['vegetarian'], ['dairy']], ['Sarson da Saag', 15, 'Mustard greens with ghee', ['vegetarian'], ['dairy']], ['Chicken Tikka Masala', 17.5, '', [], ['dairy']], ['Paneer Butter Masala', 16, '', ['vegetarian'], ['dairy', 'nuts']], ['Goat Curry', 19.5, 'Bone-in, village style', [], []]] },
      { name: 'Tandoor & Breads', station: 'Tandoor', items: [['Tandoori Chicken (Half)', 15, 'Marinated overnight', [], ['dairy']], ['Paneer Tikka', 14, '', ['vegetarian'], ['dairy']], ['Butter Naan', 3.5, '', ['vegetarian'], ['gluten', 'dairy']], ['Aloo Paratha', 5.5, 'With butter and pickle', ['vegetarian'], ['gluten', 'dairy']], ['Makki di Roti', 4.5, 'Cornmeal flatbread', ['vegan'], []]] },
      { name: 'Street Food', station: 'Fryer', items: [['Samosa Chaat', 8.5, 'Crushed samosa, chickpeas, chutneys', ['vegetarian'], ['gluten', 'dairy']], ['Pani Puri (8)', 7, '', ['vegan'], ['gluten']], ['Fish Pakora', 11, 'Besan battered', [], ['fish', 'gluten']]] },
      { name: 'Drinks', station: 'Drinks', items: [['Sweet Lassi', 4.5, '', ['vegetarian'], ['dairy']], ['Mango Lassi', 4.75, '', ['vegetarian'], ['dairy']], ['Masala Chai', 3.5, '', ['vegetarian'], ['dairy']]] },
    ],
    groups: [spice(['Curries']), { name: 'Add Bread', required: false, min: 0, max: 2, options: [['Butter Naan', 3.5], ['Tandoori Roti', 2.5]], appliesTo: ['Curries'] }, { name: 'Add Raita', required: false, min: 0, max: 1, options: [['Cucumber Raita', 3], ['Boondi Raita', 3.5]], appliesTo: ['Tandoor & Breads'] }],
  },
  pakistani: {
    categories: [
      { name: 'Karahi & Curries', station: 'Curry', items: [['Chicken Karahi', 18, 'Wok-cooked with tomato, ginger, green chili', [], []], ['Lamb Nihari', 19.5, 'Slow-cooked shank stew', [], ['gluten']], ['Haleem', 14, 'Lentils, wheat and beef', [], ['gluten']], ['Daal Tarka', 12, '', ['vegan'], []]] },
      { name: 'Rice & BBQ', station: 'Grill', items: [['Chicken Biryani', 15.5, 'Basmati, saffron, boiled egg', [], ['egg']], ['Beef Seekh Kebab (4)', 14, '', [], []], ['Chicken Tikka Boti', 14.5, '', [], ['dairy']], ['Chapli Kebab (2)', 11, 'Peshawari style', [], ['gluten']]] },
      { name: 'Breads', station: 'Tandoor', items: [['Roghni Naan', 3.5, '', ['vegetarian'], ['gluten', 'dairy']], ['Tandoori Roti', 2, '', ['vegan'], ['gluten']]] },
      { name: 'Drinks & Sweets', station: 'Drinks', items: [['Rooh Afza Milk', 4, '', ['vegetarian'], ['dairy']], ['Kheer', 5.5, 'Rice pudding', ['vegetarian'], ['dairy', 'nuts']], ['Gulab Jamun (2)', 4.5, '', ['vegetarian'], ['gluten', 'dairy']]] },
    ],
    groups: [spice(['Karahi & Curries']), { name: 'Biryani Size', required: true, min: 1, max: 1, options: [['Single', 0], ['Family (serves 4)', 22]], appliesTo: ['Rice & BBQ:Chicken Biryani'] }],
  },
  caribbean: {
    categories: [
      { name: 'Mains', station: 'Grill', items: [['Jerk Chicken Plate', 16, 'Quarter leg, rice and peas, slaw', [], []], ['Curry Goat', 19, 'Served with rice and peas', [], []], ['Oxtail Stew', 23, 'Butter beans, rice and peas', [], []], ['Brown Stew Fish', 20, 'Red snapper', [], ['fish']], ['Ital Veggie Plate', 14.5, 'Callaloo, plantain, rice', ['vegan'], []]] },
      { name: 'Roti & Patties', station: 'Fryer', items: [['Beef Patty', 3.5, 'Flaky crust', [], ['gluten']], ['Chicken Roti', 12.5, 'Curried chicken in dhalpuri', [], ['gluten']], ['Doubles (2)', 7, 'Curried chickpea, bara', ['vegan'], ['gluten']], ['Fried Plantain', 5, '', ['vegan'], []]] },
      { name: 'Drinks', station: 'Drinks', items: [['Ting Grapefruit Soda', 3.25, ''], ['Sorrel', 4, 'Hibiscus & ginger', ['vegan']], ['Carrot Juice', 4.5, 'Spiced with nutmeg', ['vegetarian'], ['dairy']]] },
    ],
    groups: [spice(['Mains']), { name: 'Side', required: false, min: 0, max: 1, options: [['Mac & Cheese', 4], ['Steamed Veg', 3.5], ['Fried Dumpling', 3]], appliesTo: ['Mains'] }],
  },
  portuguese: {
    categories: [
      { name: 'Grill', station: 'Grill', items: [['Piri-Piri Chicken (Half)', 15.5, 'Charcoal grilled, house piri-piri', [], []], ['Piri-Piri Chicken (Whole)', 27, '', [], []], ['Grilled Sardines (4)', 16, 'Sea salt, lemon', [], ['fish']], ['Espetada de Vaca', 21, 'Beef skewer, bay leaf', [], []]] },
      { name: 'Sandwiches & Petiscos', station: 'Fryer', items: [['Bifana', 9.5, 'Garlic pork on a papo seco', [], ['gluten']], ['Prego no Pao', 10.5, 'Steak sandwich', [], ['gluten']], ['Bacalhau a Bras', 17.5, 'Salt cod, egg, fried potato', [], ['fish', 'egg']], ['Chouriço Assado', 9, 'Flambeed chorizo', [], []]] },
      { name: 'Sweets & Drinks', station: 'Cold', items: [['Pastel de Nata', 2.75, 'Custard tart', ['vegetarian'], ['gluten', 'dairy', 'egg']], ['Arroz Doce', 4.5, '', ['vegetarian'], ['dairy']], ['Super Bock', 5.5, 'Lager 330ml'], ['Guarana Antarctica', 3, '']] },
    ],
    groups: [{ name: 'Heat', required: true, min: 1, max: 1, options: [['Mild', 0], ['Hot', 0], ['Extra Piri-Piri', 0.5]], appliesTo: ['Grill'] }, { name: 'Side', required: true, min: 1, max: 1, options: [['Fries', 0], ['Rice', 0], ['Salad', 0.5]], appliesTo: ['Grill'] }],
  },
  lebanese: {
    categories: [
      { name: 'Wraps & Plates', station: 'Grill', items: [['Chicken Shawarma Wrap', 11, 'Garlic toum, pickles', [], ['gluten', 'egg']], ['Beef Shawarma Plate', 17, 'Rice, salad, hummus', [], ['sesame']], ['Falafel Wrap', 9.5, 'Tahini, tomato, parsley', ['vegan'], ['gluten', 'sesame']], ['Mixed Grill Platter', 24, 'Kafta, shish tawook, lamb', [], []]] },
      { name: 'Mezze', station: 'Cold', items: [['Hummus', 7, '', ['vegan'], ['sesame']], ['Baba Ghanouj', 7.5, '', ['vegan'], ['sesame']], ['Tabouleh', 8, '', ['vegan'], ['gluten']], ['Fattoush', 9, 'Crisp pita, sumac', ['vegan'], ['gluten']], ['Kibbeh (3)', 9, '', [], ['gluten', 'nuts']]] },
      { name: 'Desserts & Drinks', station: 'Drinks', items: [['Baklava (3)', 6, '', ['vegetarian'], ['gluten', 'nuts']], ['Ayran', 3.5, '', ['vegetarian'], ['dairy']], ['Lebanese Coffee', 3.5, '', ['vegan']]] },
    ],
    groups: [{ name: 'Extras', required: false, min: 0, max: 3, options: [['Extra Garlic Sauce', 1], ['Pickled Turnips', 1], ['Add Fries', 3.5]], appliesTo: ['Wraps & Plates'] }, { name: 'Protein Swap', required: false, min: 0, max: 1, options: [['Chicken', 0], ['Beef', 1.5], ['Falafel', -1]], appliesTo: ['Wraps & Plates:Chicken Shawarma Wrap'] }],
  },
  bakery: {
    categories: [
      { name: 'Pastries', station: 'Bakery', items: [['Butter Croissant', 3.5, '', ['vegetarian'], ['gluten', 'dairy']], ['Almond Croissant', 4.5, '', ['vegetarian'], ['gluten', 'dairy', 'nuts']], ['Cinnamon Bun', 4, '', ['vegetarian'], ['gluten', 'dairy', 'egg']], ['Cardamom Knot', 4.25, '', ['vegetarian'], ['gluten', 'dairy']]] },
      { name: 'Breads & Cakes', station: 'Bakery', items: [['Sourdough Loaf', 8, '', ['vegan'], ['gluten']], ['Rasmalai Cake Slice', 6.5, 'Cardamom and pistachio', ['vegetarian'], ['gluten', 'dairy', 'nuts', 'egg']], ['Chocolate Fudge Cake (6")', 28, '', ['vegetarian'], ['gluten', 'dairy', 'egg']], ['Vegan Brownie', 4, '', ['vegan'], ['gluten', 'nuts']]] },
      { name: 'Cafe', station: 'Drinks', items: [['Flat White', 4.5, '', ['vegetarian'], ['dairy']], ['Chai Latte', 4.75, '', ['vegetarian'], ['dairy']], ['Cold Brew', 4.5, '', ['vegan']], ['Egg & Cheese Sandwich', 7.5, 'On brioche', [], ['egg', 'gluten', 'dairy']]] },
    ],
    groups: [{ name: 'Milk', required: false, min: 0, max: 1, options: [['Oat', 0.75], ['Almond', 0.75]], appliesTo: ['Cafe'] }, { name: 'Warm it up', required: false, min: 0, max: 1, options: [['Warmed', 0]], appliesTo: ['Pastries'] }],
  },
  // ---- convenience stores: snacks, drinks, groceries, household. Basic groceries are zero-rated. ----
  convenience: {
    categories: [
      { name: 'Snacks & Candy', station: 'Counter', items: [['Lays Classic Chips (235g)', 4.99, ''], ['Doritos Nacho Cheese (230g)', 4.99, ''], ['Ruffles All Dressed (220g)', 4.99, '', [], []], ['Kit Kat 4-Finger', 1.99, '', ['vegetarian'], ['dairy', 'gluten']], ['Reese Peanut Butter Cups', 2.29, '', ['vegetarian'], ['peanuts', 'dairy']], ['Aero Chocolate Bar', 2.19, '', ['vegetarian'], ['dairy']], ['Haribo Goldbears (150g)', 3.49, '']] },
      { name: 'Cold Drinks', station: 'Drinks', items: [['Coca-Cola 355ml', 2.25, ''], ['Pepsi 2L', 3.99, ''], ['Gatorade Cool Blue 710ml', 3.29, ''], ['Red Bull 250ml', 3.99, ''], ['Dasani Water 710ml', 1.99, ''], ['Nestea Iced Tea 500ml', 2.79, '']] },
      { name: 'Dairy, Bread & Eggs', station: 'Counter', items: [['Milk 2% (2L)', 5.49, '', ['vegetarian'], ['dairy'], Z], ['Large White Eggs (12)', 4.79, '', ['vegetarian'], ['egg'], Z], ['White Sandwich Bread', 3.29, '', ['vegan'], ['gluten'], Z], ['Salted Butter (454g)', 6.49, '', ['vegetarian'], ['dairy'], Z], ['Cheddar Slices (240g)', 5.99, '', ['vegetarian'], ['dairy'], Z]] },
      { name: 'Pantry & Fresh', station: 'Counter', items: [['Bananas (1 lb)', 0.99, '', ['vegan'], [], Z], ['Basmati Rice (2kg)', 9.99, '', ['vegan'], [], Z], ['Instant Noodles (5-pack)', 5.49, '', ['vegan'], ['gluten']], ['Peanut Butter (500g)', 5.99, '', ['vegan'], ['peanuts'], Z], ['Canned Chickpeas (540ml)', 1.99, '', ['vegan'], [], Z]] },
      { name: 'Household Essentials', station: 'Counter', items: [['Paper Towels (2 rolls)', 3.99, ''], ['Dish Soap (500ml)', 4.49, ''], ['Toilet Paper (4 rolls)', 4.99, ''], ['AA Batteries (4)', 7.99, ''], ['Hand Soap (250ml)', 3.49, ''], ['Garbage Bags (20)', 5.49, '']] },
    ],
    groups: [{ name: 'Pack', required: false, min: 0, max: 1, options: [['Single', 0], ['6-Pack', 11]], appliesTo: ['Cold Drinks:Coca-Cola 355ml', 'Cold Drinks:Nestea Iced Tea 500ml'] }, { name: 'Milk Size', required: true, min: 1, max: 1, options: [['2L', 0], ['4L', 3.2], ['1L', -2]], appliesTo: ['Dairy, Bread & Eggs:Milk 2% (2L)'] }],
  },
  variety: {
    categories: [
      { name: 'South Asian Snacks', station: 'Counter', items: [['Haldiram Bhujia (200g)', 3.99, '', ['vegan'], []], ['Parle-G Biscuits', 1.49, '', ['vegetarian'], ['gluten', 'dairy']], ['Mixed Namkeen (400g)', 5.49, '', ['vegan'], ['peanuts']], ['Frozen Samosas (12)', 7.99, '', ['vegan'], ['gluten']], ['Gulab Jamun Tin (1kg)', 9.49, '', ['vegetarian'], ['gluten', 'dairy']]] },
      { name: 'Drinks', station: 'Drinks', items: [['Rooh Afza (800ml)', 8.99, ''], ['Mango Juice Tin (1L)', 3.49, ''], ['Lassi Sweet (500ml)', 3.29, '', ['vegetarian'], ['dairy']], ['Pop Assorted Can', 1.75, ''], ['Karak Chai Mix (20 sachets)', 6.99, '', ['vegetarian'], ['dairy']]] },
      { name: 'Staples', station: 'Counter', items: [['Atta Flour (4kg)', 11.99, '', ['vegan'], ['gluten'], Z], ['Toor Dal (2lb)', 6.99, '', ['vegan'], [], Z], ['Ghee (400g)', 9.99, '', ['vegetarian'], ['dairy'], Z], ['Fresh Paneer (350g)', 6.49, '', ['vegetarian'], ['dairy'], Z], ['Plain Yogurt (1kg)', 4.99, '', ['vegetarian'], ['dairy'], Z], ['Onions (3lb)', 3.99, '', ['vegan'], [], Z], ['Green Chilies (100g)', 1.49, '', ['vegan'], [], Z]] },
      { name: 'Household', station: 'Counter', items: [['Incense Sticks (pack)', 2.99, ''], ['Aluminum Foil (25 ft)', 4.49, ''], ['Laundry Detergent (1.8L)', 11.99, ''], ['Phone Charging Cable', 9.99, ''], ['Lighter', 2.49, '']] },
      { name: 'Ready to Eat', station: 'Counter', items: [['Chicken Patty Sandwich', 5.5, 'Made fresh each morning', [], ['gluten', 'egg']], ['Veg Puff', 2.5, '', ['vegetarian'], ['gluten', 'dairy']], ['Hot Chai (12oz)', 2.25, '', ['vegetarian'], ['dairy']]] },
    ],
    groups: [{ name: 'Chai Sweetness', required: false, min: 0, max: 1, options: [['Regular', 0], ['Less Sugar', 0], ['No Sugar', 0]], appliesTo: ['Ready to Eat:Hot Chai (12oz)'] }],
  },
};

const BRAMPTON_ZONES = ['Downtown Brampton', 'Bramalea', 'Springdale', 'Heart Lake'];

const RAW_DEFS: Def[] = [
  // ---- Brampton ----
  { name: 'Punjab Grill Brampton', merchant: 13, cuisines: ['Punjabi', 'Indian'], menu: 'punjabi', zone: 'Downtown Brampton', dLat: 0.002, dLng: 0.002, street: '8 Queen St W', postal: 'L6Y 1L7', price: 2, tier: 'Standard', prep: 25, hours: 'late', featured: true },
  { name: 'Bramalea Biryani House', merchant: 14, cuisines: ['Pakistani', 'Halal'], menu: 'pakistani', zone: 'Bramalea', dLat: 0.003, dLng: -0.002, street: '25 Peel Centre Dr', postal: 'L6T 3R5', price: 2, tier: 'Standard', prep: 25, hours: 'late' },
  { name: 'Spice Garden Dhaba', merchant: 15, cuisines: ['Punjabi', 'Indian'], menu: 'punjabi', zone: 'Springdale', dLat: -0.003, dLng: 0.003, street: '10088 McLaughlin Rd', postal: 'L7A 2X5', price: 2, tier: 'Premium', prep: 25 },
  { name: 'Jerk Junction', merchant: 16, cuisines: ['Caribbean'], menu: 'caribbean', zone: 'Heart Lake', dLat: 0.002, dLng: -0.003, street: '179 Sandalwood Pkwy W', postal: 'L7A 1A3', price: 2, tier: 'Starter', prep: 22 },
  { name: 'Brampton Corner Mart', merchant: 17, cuisines: ['Convenience'], menu: 'convenience', zone: 'Downtown Brampton', dLat: -0.004, dLng: -0.003, street: '45 Main St N', postal: 'L6V 1N6', price: 1, tier: 'Starter', prep: 8, hours: 'allday', minOrder: 8 },
  { name: 'Springdale Convenience & Variety', merchant: 18, cuisines: ['Convenience'], menu: 'variety', zone: 'Springdale', dLat: 0.004, dLng: -0.002, street: '9950 Bramalea Rd', postal: 'L6R 0B4', price: 1, tier: 'Starter', prep: 8, hours: 'conv', minOrder: 8, mode: RestaurantServiceMode.PICKUP_ONLY },
  { name: 'Heart Lake Pizza Co.', merchant: 19, cuisines: ['Pizza', 'Italian'], menu: 'pizza', zone: 'Heart Lake', dLat: -0.003, dLng: 0.002, street: '10 Great Lakes Dr', postal: 'L6R 2K7', price: 2, tier: 'Standard', prep: 20, hours: 'late' },
  // ---- Mississauga ----
  { name: 'Casa Lusitana Portuguese Grill', merchant: 20, cuisines: ['Portuguese', 'Seafood'], menu: 'portuguese', zone: 'Port Credit', dLat: -0.002, dLng: 0.003, street: '120 Lakeshore Rd W', postal: 'L5H 1E9', price: 3, tier: 'Premium', prep: 25, featured: true },
  { name: 'Cedar & Olive Lebanese Kitchen', merchant: 21, cuisines: ['Lebanese', 'Middle Eastern', 'Halal'], menu: 'lebanese', zone: 'City Centre', dLat: 0.004, dLng: 0.004, street: '4141 Dixie Rd', postal: 'L4W 1V5', price: 2, tier: 'Standard', prep: 20, mode: RestaurantServiceMode.CLOSED },
  { name: 'Maple Corner Convenience', merchant: 22, cuisines: ['Convenience'], menu: 'convenience', zone: 'Erin Mills', dLat: 0.002, dLng: -0.004, street: '3050 Erin Mills Pkwy', postal: 'L5L 5Z6', price: 1, tier: 'Starter', prep: 8, hours: 'allday', minOrder: 8 },
  { name: 'Lakeshore 24/7 Variety', merchant: 23, cuisines: ['Convenience'], menu: 'variety', zone: 'Port Credit', dLat: 0.003, dLng: -0.004, street: '255 Lakeshore Rd E', postal: 'L5G 1G6', price: 1, tier: 'Starter', prep: 8, hours: 'allday', minOrder: 8, mode: RestaurantServiceMode.PICKUP_ONLY },
  { name: 'Tokyo Table Sushi', merchant: 24, cuisines: ['Sushi', 'Japanese'], menu: 'asian', zone: 'Meadowvale', dLat: -0.004, dLng: 0.001, street: '6830 Meadowvale Town Centre Cir', postal: 'L5N 4B7', price: 3, tier: 'Standard', prep: 25 },
  { name: 'Smokehouse Burger Lab', merchant: 25, cuisines: ['Burgers', 'BBQ'], menu: 'burgers', zone: 'Streetsville', dLat: 0.001, dLng: 0.004, street: '260 Queen St S', postal: 'L5M 1L7', price: 2, tier: 'Standard', prep: 18, hours: 'late' },
  { name: 'Sweet Crumbs Bakery & Cafe', merchant: 26, cuisines: ['Bakery', 'Coffee & Tea', 'Desserts'], menu: 'bakery', zone: 'Erin Mills', dLat: -0.003, dLng: 0.004, street: '2150 Burnhamthorpe Rd W', postal: 'L5L 5Z5', price: 2, tier: 'Starter', prep: 10 },
];

export const EXTRA_DEFS: Def[] = RAW_DEFS.map((d) => ({ ...d, city: BRAMPTON_ZONES.includes(d.zone) ? 'Brampton' : 'Mississauga' }));
