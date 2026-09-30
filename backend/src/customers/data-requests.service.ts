import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Address, CustomerProfile, DataRequest, Order, Review, User } from '../database/entities';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';

/** PIPEDA data-subject requests (spec section 12): access, deletion, correction, consent withdrawal. */
@Injectable()
export class DataRequestsService {
  constructor(
    @InjectRepository(DataRequest) private requests: Repository<DataRequest>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(CustomerProfile) private profiles: Repository<CustomerProfile>,
    @InjectRepository(Address) private addresses: Repository<Address>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    private notifications: NotificationsService,
    private settings: SettingsService,
  ) {}

  async create(userId: string, type: DataRequest['type'], notes?: string): Promise<DataRequest> {
    const existingOpen = await this.requests.findOne({ where: { userId, type, status: 'PENDING' } });
    if (existingOpen) return existingOpen;

    const dueDays = this.settings.get<number>('compliance.dataRequestDays', 30);
    const request = await this.requests.save(
      this.requests.create({
        userId,
        type,
        status: 'PENDING',
        notes: notes ?? null,
        dueAt: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000),
      }),
    );

    if (type === 'DELETION') {
      await this.profiles.update({ userId }, { deletionRequestedAt: new Date() } as any);
    }
    if (type === 'ACCESS') {
      request.resultData = await this.buildExport(userId);
      request.status = 'COMPLETED';
      request.completedAt = new Date();
      await this.requests.save(request);
    }

    await this.notifications.notifyOps('order.stuck', { code: `PRIVACY-${type}`, reason: `New ${type} request from a customer (due ${request.dueAt?.toISOString().slice(0, 10)})` }).catch(() => undefined);
    return request;
  }

  forUser(userId: string): Promise<DataRequest[]> {
    return this.requests.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async exportForOwner(userId: string, id: string): Promise<Record<string, any>> {
    const request = await this.requests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('Request not found');
    if (request.userId !== userId) throw new BadRequestException('Not your request');
    if (request.type !== 'ACCESS') throw new BadRequestException('Only ACCESS requests produce an export');
    return request.resultData ?? this.buildExport(userId);
  }

  private async buildExport(userId: string): Promise<Record<string, any>> {
    const [user, profile, addresses, orders, reviews] = await Promise.all([
      this.users.findOne({ where: { id: userId } }),
      this.profiles.findOne({ where: { userId } }),
      this.addresses.find({ where: { customerId: userId } }),
      this.orders.find({ where: { customerId: userId }, order: { createdAt: 'DESC' }, take: 200 }),
      this.reviews.find({ where: { customerId: userId } }),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      account: user ? { id: user.id, email: user.email, phone: user.phone, firstName: user.firstName, lastName: user.lastName, createdAt: user.createdAt } : null,
      profile,
      addresses,
      orders: orders.map((o) => ({ id: o.id, code: o.code, status: o.status, total: o.total, createdAt: o.createdAt })),
      reviews,
    };
  }
}
