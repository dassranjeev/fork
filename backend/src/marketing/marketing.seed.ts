import { DataSource } from 'typeorm';
import { Banner, CmsPage, Faq, Promotion } from '../database/entities';
import { FundedBy, PromoType } from '../common/enums';
import { SeedOptions } from '../database/seed-types';

/** Legal / help pages (EN, always) + a French translation of the two most-read ones. */
const CMS_PAGES: { slug: string; title: string; body: string; category: CmsPage['category']; language?: string }[] = [
  {
    slug: 'terms',
    title: 'Terms of Service',
    category: 'LEGAL',
    body:
      'Welcome to FORKY. By placing an order, creating an account, or using the FORKY platform, you agree to these Terms of Service. ' +
      'FORKY connects customers, restaurants and independent delivery drivers in Ontario. Orders are subject to restaurant availability, ' +
      'delivery zone coverage and applicable fees shown at checkout. Please contact support@forky.ca with any questions.',
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    category: 'LEGAL',
    body:
      'FORKY collects the personal information needed to process orders, payments and deliveries (name, contact details, delivery address, ' +
      'order history and, where applicable, payment tokens). We do not sell personal information. Under Canadian privacy law (PIPEDA) you may ' +
      'request access to, correction of, or deletion of your personal information at any time from Account > Privacy.',
  },
  {
    slug: 'refund-policy',
    title: 'Refund Policy',
    category: 'LEGAL',
    body:
      'If an order arrives with a missing or incorrect item, is significantly late, or is cancelled by the restaurant, you may be eligible for ' +
      'a refund or FORKY wallet credit. Report an issue from Order Details within 48 hours of delivery and our support team (or an automatic ' +
      'rule, for smaller amounts) will resolve it, usually within minutes.',
  },
  {
    slug: 'driver-agreement',
    title: 'Driver Partner Agreement',
    category: 'LEGAL',
    body:
      'As an independent contractor delivering for FORKY, you are responsible for your own vehicle, insurance and applicable taxes (a T4A is ' +
      'issued annually). You are paid per completed delivery (base + distance + applicable boosts) plus 100% of tips, on the weekly payout cycle ' +
      'described in your driver dashboard, or instantly via cash-out for a small fee.',
  },
  {
    slug: 'merchant-agreement',
    title: 'Merchant Agreement',
    category: 'LEGAL',
    body:
      'This agreement governs your restaurant\'s participation on FORKY. FORKY charges a commission on each order (see your Commission tier) ' +
      'and remits the balance on the weekly payout cycle, along with a statement and invoice for FORKY HST. You are responsible for menu ' +
      'accuracy, food safety, and honouring accepted orders within the promised prep time.',
  },
  {
    slug: 'terms',
    title: "Conditions d'utilisation",
    category: 'LEGAL',
    language: 'fr',
    body:
      "Bienvenue sur FORKY. En passant une commande ou en utilisant la plateforme FORKY, vous acceptez les presentes conditions d'utilisation. " +
      "FORKY met en relation des clients, des restaurants et des livreurs independants en Ontario.",
  },
  {
    slug: 'privacy',
    title: 'Politique de confidentialite',
    category: 'LEGAL',
    language: 'fr',
    body:
      'FORKY recueille les renseignements personnels necessaires au traitement des commandes, des paiements et des livraisons. ' +
      'Conformement a la LPRPDE, vous pouvez demander en tout temps l\'acces, la correction ou la suppression de vos renseignements personnels.',
  },
];

const FAQS: { question: string; answer: string; audience: Faq['audience']; category: string; sortOrder: number; language?: string }[] = [
  // customers
  { question: 'How do I track my order?', answer: 'Open Orders > the active order to see live status and, once a driver is assigned, their location on the map.', audience: 'CUSTOMER', category: 'Orders', sortOrder: 1 },
  { question: 'What if an item is missing or wrong?', answer: 'Report it from Order Details within 48 hours. Eligible issues are refunded or credited automatically, usually within minutes.', audience: 'CUSTOMER', category: 'Orders', sortOrder: 2 },
  { question: 'How do I use a promo code or gift card?', answer: 'Enter your promo code at checkout, or redeem a gift card from Wallet > Redeem gift card to add its balance to your FORKY wallet.', audience: 'CUSTOMER', category: 'Payments', sortOrder: 3 },
  { question: 'How does the referral programme work?', answer: 'Share your referral code from Account > Referrals. When a friend places and receives their first delivered order, you both receive a wallet credit.', audience: 'CUSTOMER', category: 'Referrals', sortOrder: 4 },
  { question: 'Comment suivre ma commande ?', answer: 'Ouvrez Commandes > la commande active pour voir le statut en direct et la position du livreur.', audience: 'CUSTOMER', category: 'Orders', sortOrder: 1, language: 'fr' },
  // drivers
  { question: 'How and when do I get paid?', answer: 'Earnings are paid out weekly by default, or instantly via cash-out for a small fee. Tips are 100% yours.', audience: 'DRIVER', category: 'Earnings', sortOrder: 1 },
  { question: 'What documents do I need to drive?', answer: "A valid licence, vehicle registration, proof of insurance, a photo and proof of work eligibility. Upload them from Documents in the driver app.", audience: 'DRIVER', category: 'Onboarding', sortOrder: 2 },
  { question: 'What do I do if I feel unsafe?', answer: 'Use the SOS button in the driver app at any time. It alerts our operations team immediately with your location.', audience: 'DRIVER', category: 'Safety', sortOrder: 3 },
  // restaurants
  { question: 'How do I update my menu or mark an item out of stock?', answer: 'Go to Menu Management in the restaurant portal. Toggling an item to 86/out-of-stock hides it immediately and can auto-restock at a set time.', audience: 'RESTAURANT', category: 'Menu', sortOrder: 1 },
  { question: 'How do self-serve promotions work?', answer: 'Create a % off, BOGO, free item or free delivery promo from Promotions in your portal. Depending on your settings it may need FORKY approval before it goes live.', audience: 'RESTAURANT', category: 'Marketing', sortOrder: 2 },
  { question: 'When do I get paid?', answer: 'Payouts follow the weekly cycle in Finance > Payouts, with a statement and HST invoice for each period.', audience: 'RESTAURANT', category: 'Payouts', sortOrder: 3 },
];

const BANNERS: { title: string; subtitle?: string; imageUrl: string; link?: string; sortOrder: number }[] = [
  { title: 'Welcome to FORKY', subtitle: 'New here? Get 10% off your first order with WELCOME10.', imageUrl: 'https://images.forky.ca/banners/welcome.jpg', link: 'promo:WELCOME10', sortOrder: 1 },
  { title: 'Free delivery this week', subtitle: 'Use code FREEDEL on orders over $20.', imageUrl: 'https://images.forky.ca/banners/free-delivery.jpg', link: 'promo:FREEDEL', sortOrder: 2 },
];

/** Platform-funded promo codes. Always usable in every environment (safe, low-value demo codes). */
const PROMOS: Partial<Promotion>[] = [
  {
    code: 'WELCOME10',
    name: 'Welcome 10% off',
    description: '10% off your first order (max $15 off).',
    type: PromoType.PERCENT,
    value: 10,
    maxDiscount: 15,
    minSubtotal: 0,
    fundedBy: FundedBy.PLATFORM,
    perUserLimit: 1,
    firstOrderOnly: true,
    autoApply: false,
    active: true,
    budget: 0,
  },
  {
    code: 'FREEDEL',
    name: 'Free delivery',
    description: 'Free delivery on orders over $20.',
    type: PromoType.FREE_DELIVERY,
    value: 0,
    minSubtotal: 20,
    fundedBy: FundedBy.PLATFORM,
    perUserLimit: 3,
    orderTypes: ['DELIVERY'],
    autoApply: false,
    active: true,
    budget: 0,
  },
  {
    code: 'SAVE5',
    name: '$5 off',
    description: '$5 off orders over $30.',
    type: PromoType.FIXED,
    value: 5,
    minSubtotal: 30,
    fundedBy: FundedBy.PLATFORM,
    perUserLimit: 0,
    autoApply: false,
    active: true,
    budget: 0,
  },
];

/**
 * Idempotent (looked up by natural key: slug+language for CMS, question+audience for FAQ, title for
 * banners, code for promos). CMS/FAQ/banners are foundational content and always seed; promo codes
 * seed only for demo environments (opts.demo) since they represent sample marketing codes.
 */
export async function seedMarketing(ds: DataSource, opts: SeedOptions): Promise<void> {
  const pages = ds.getRepository(CmsPage);
  const faqs = ds.getRepository(Faq);
  const banners = ds.getRepository(Banner);
  const promos = ds.getRepository(Promotion);

  for (const p of CMS_PAGES) {
    const language = p.language ?? 'en';
    const existing = await pages.findOne({ where: { slug: p.slug, language } });
    if (existing) continue;
    await pages.save(pages.create({ slug: p.slug, language, title: p.title, body: p.body, category: p.category, published: true }));
    console.log(`  + cms page ${p.slug} (${language})`);
  }

  for (const f of FAQS) {
    const language = f.language ?? 'en';
    const existing = await faqs.findOne({ where: { question: f.question, audience: f.audience, language } });
    if (existing) continue;
    await faqs.save(
      faqs.create({ question: f.question, answer: f.answer, audience: f.audience, category: f.category, sortOrder: f.sortOrder, language, active: true }),
    );
    console.log(`  + faq (${f.audience}) ${f.question}`);
  }

  for (const b of BANNERS) {
    const existing = await banners.findOne({ where: { title: b.title } });
    if (existing) continue;
    await banners.save(banners.create({ ...b, placement: 'HOME', active: true }));
    console.log(`  + banner ${b.title}`);
  }

  if (opts.demo) {
    for (const p of PROMOS) {
      const existing = await promos.findOne({ where: { code: p.code! } });
      if (existing) continue;
      await promos.save(
        promos.create({
          code: p.code,
          name: p.name,
          description: p.description ?? null,
          type: p.type,
          value: p.value ?? 0,
          maxDiscount: p.maxDiscount ?? null,
          minSubtotal: p.minSubtotal ?? 0,
          fundedBy: p.fundedBy,
          orderTypes: p.orderTypes ?? [],
          usageLimit: null,
          perUserLimit: p.perUserLimit ?? 1,
          firstOrderOnly: !!p.firstOrderOnly,
          autoApply: !!p.autoApply,
          active: !!p.active,
          pendingApproval: false,
          budget: p.budget ?? 0,
          spent: 0,
          usedCount: 0,
        }),
      );
      console.log(`  + promo code ${p.code}`);
    }
  }
}
