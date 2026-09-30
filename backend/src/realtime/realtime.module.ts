import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import { DriverProfile, Order, RestaurantMember, User } from '../database/entities';
import { UserType } from '../common/enums';
import { JwtPayload } from '../common/auth.types';
import { ConfigService } from '@nestjs/config';

/**
 * Room naming (use these from services via RealtimeService):
 *   user:{userId}          - private events for one user (all their devices)
 *   order:{orderId}        - live tracking for an order (customer, restaurant, driver, staff)
 *   restaurant:{id}        - new orders / status changes for a restaurant location (tablet + portal)
 *   driver:{driverId}      - offers & assignments for a driver profile
 *   zone:{zoneId}          - zone-level ops events
 *   admin:ops              - all staff dashboards / live map
 *
 * Event names (server -> client):
 *   order.created, order.updated, order.status, order.eta, order.late, order.unassigned
 *   driver.offer, driver.offer.cancelled, driver.location, driver.status
 *   notification, ticket.updated, sos.alert, kds.ticket
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger('Realtime');
  server: Server | null = null;
  /** Set by DriversModule: persists driver GPS pings that arrive over WebSocket. */
  locationHook?: (p: { driverId: string; lat: number; lng: number; heading?: number; orderId?: string; at: string }) => void;

  emitToUser(userId: string, event: string, payload: any) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
  emitToOrder(orderId: string, event: string, payload: any) {
    this.server?.to(`order:${orderId}`).emit(event, payload);
  }
  emitToRestaurant(restaurantId: string, event: string, payload: any) {
    this.server?.to(`restaurant:${restaurantId}`).emit(event, payload);
  }
  emitToDriver(driverId: string, event: string, payload: any) {
    this.server?.to(`driver:${driverId}`).emit(event, payload);
  }
  emitToZone(zoneId: string, event: string, payload: any) {
    this.server?.to(`zone:${zoneId}`).emit(event, payload);
  }
  emitToOps(event: string, payload: any) {
    this.server?.to('admin:ops').emit(event, payload);
  }
  emitToRoom(room: string, event: string, payload: any) {
    this.server?.to(room).emit(event, payload);
  }
  /** Online sockets in a room (used for dashboards). */
  async countInRoom(room: string) {
    return (await this.server?.in(room).fetchSockets())?.length ?? 0;
  }
}

@WebSocketGateway({ cors: { origin: true, credentials: true }, transports: ['websocket', 'polling'] })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger('RealtimeGateway');

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private rt: RealtimeService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    @InjectRepository(Order) private orders: Repository<Order>,
  ) {}

  afterInit(server: Server) {
    this.rt.server = server;
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string)?.replace(/^Bearer\s+/i, '') ||
        (client.handshake.query?.token as string);
      if (!token) throw new Error('no token');
      const payload = this.jwt.verify<JwtPayload>(token, { secret: this.config.get('jwt.secret') });
      if (payload.pending2fa) throw new Error('2fa pending');
      const user = await this.users.findOne({ where: { id: payload.sub } });
      if (!user) throw new Error('unknown user');
      client.data.user = { id: user.id, type: user.type };
      client.join(`user:${user.id}`);
      if (user.type === UserType.STAFF || user.type === UserType.SUPER_ADMIN) {
        client.join('admin:ops');
      } else if (user.type === UserType.DRIVER) {
        const dp = await this.drivers.findOne({ where: { userId: user.id } });
        if (dp) {
          client.data.driverId = dp.id;
          client.join(`driver:${dp.id}`);
          if (dp.activeZoneId) client.join(`zone:${dp.activeZoneId}`);
        }
      } else if (user.type === UserType.RESTAURANT) {
        const ms = await this.members.find({ where: { userId: user.id, active: true } });
        const restaurantIds = new Set<string>();
        for (const m of ms) {
          if (m.restaurantId) restaurantIds.add(m.restaurantId);
        }
        // owners: all locations of merchant
        const ownerMerchants = ms.filter((m) => !m.restaurantId).map((m) => m.merchantId);
        if (ownerMerchants.length) {
          const rows: { id: string }[] = await this.users.manager.query(
            `SELECT id FROM restaurants WHERE "merchantId" = ANY($1)`,
            [ownerMerchants],
          );
          rows.forEach((r) => restaurantIds.add(r.id));
        }
        client.data.restaurantIds = [...restaurantIds];
        restaurantIds.forEach((id) => client.join(`restaurant:${id}`));
      }
      client.emit('connected', { userId: user.id, type: user.type });
    } catch (e: any) {
      this.logger.debug(`socket rejected: ${e.message}`);
      client.emit('error', { message: 'unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket) {}

  /** Customer / anyone involved in an order subscribes to live updates. */
  @SubscribeMessage('order.subscribe')
  async subscribeOrder(@ConnectedSocket() client: Socket, @MessageBody() body: { orderId: string }) {
    const u = client.data.user as { id: string; type: UserType } | undefined;
    if (!u || !body?.orderId) return { ok: false };
    const order = await this.orders.findOne({ where: { id: body.orderId } });
    if (!order) return { ok: false, error: 'not_found' };
    const allowed =
      u.type === UserType.STAFF ||
      u.type === UserType.SUPER_ADMIN ||
      (u.type === UserType.CUSTOMER && order.customerId === u.id) ||
      (u.type === UserType.DRIVER && order.driverId && order.driverId === client.data.driverId) ||
      (u.type === UserType.RESTAURANT && (client.data.restaurantIds ?? []).includes(order.restaurantId));
    if (!allowed) return { ok: false, error: 'forbidden' };
    client.join(`order:${order.id}`);
    return { ok: true };
  }

  @SubscribeMessage('order.unsubscribe')
  unsubscribeOrder(@ConnectedSocket() client: Socket, @MessageBody() body: { orderId: string }) {
    if (body?.orderId) client.leave(`order:${body.orderId}`);
    return { ok: true };
  }

  /** Driver pushes GPS over the socket (REST endpoint exists too). Handled by DriversModule via event. */
  @SubscribeMessage('driver.location')
  driverLocation(@ConnectedSocket() client: Socket, @MessageBody() body: { lat: number; lng: number; heading?: number; orderId?: string }) {
    if (client.data.user?.type !== UserType.DRIVER || !client.data.driverId) return { ok: false };
    // Re-broadcast to the ops room + order room; persistence is done by DriverLocationService listening on this hook.
    const payload = { driverId: client.data.driverId, ...body, at: new Date().toISOString() };
    this.rt.emitToOps('driver.location', payload);
    if (body.orderId) this.rt.emitToOrder(body.orderId, 'driver.location', payload);
    this.rt.locationHook?.(payload);
    return { ok: true };
  }

  /** Staff can join a zone room for zone-scoped events. */
  @SubscribeMessage('zone.subscribe')
  subscribeZone(@ConnectedSocket() client: Socket, @MessageBody() body: { zoneId: string }) {
    const t = client.data.user?.type;
    if ((t === UserType.STAFF || t === UserType.SUPER_ADMIN) && body?.zoneId) client.join(`zone:${body.zoneId}`);
    return { ok: true };
  }
}

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, DriverProfile, RestaurantMember, Order])],
  providers: [RealtimeService, RealtimeGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
