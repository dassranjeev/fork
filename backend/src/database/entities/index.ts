import * as identity from './identity.entities';
import * as geo from './geo.entities';
import * as restaurant from './restaurant.entities';
import * as driver from './driver.entities';
import * as customer from './customer.entities';
import * as order from './order.entities';
import * as finance from './finance.entities';
import * as marketing from './marketing.entities';
import * as support from './support.entities';
import * as system from './system.entities';
import * as proof from './proof.entities';
import * as rating from './rating.entities';
import * as assistant from './assistant.entities';
import * as assistantTraining from './assistant-training.entities';
import * as stripe from './stripe.entities';

export * from './identity.entities';
export * from './geo.entities';
export * from './restaurant.entities';
export * from './driver.entities';
export * from './customer.entities';
export * from './order.entities';
export * from './finance.entities';
export * from './marketing.entities';
export * from './support.entities';
export * from './system.entities';
export * from './proof.entities';
export * from './rating.entities';
export * from './assistant.entities';
export * from './assistant-training.entities';
export * from './stripe.entities';

const isEntityClass = (v: any) => typeof v === 'function' && /^class\s/.test(Function.prototype.toString.call(v));

/** Every TypeORM entity in the project (auto-collected from the entity files). */
export const ALL_ENTITIES = [identity, geo, restaurant, driver, customer, order, finance, marketing, support, system, rating, proof, assistant, assistantTraining, stripe]
  .flatMap((m) => Object.values(m))
  .filter(isEntityClass) as Function[];
