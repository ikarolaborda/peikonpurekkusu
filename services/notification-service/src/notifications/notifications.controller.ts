import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, Headers, HttpCode, Param, Post, Res, Sse, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { map, merge, Observable } from 'rxjs';
import { Notification } from '../entities/notification.entity.js';
import { SseHub, type LiveNotification } from './sse-hub.service.js';

/**
 * Inbox + live stream, behind Traefik ForwardAuth (identity via X-User-Id,
 * trustworthy only because the service is reachable solely through the gateway).
 */
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly em: EntityManager,
    private readonly hub: SseHub,
  ) {}

  @Get()
  async inbox(@Headers('x-user-id') userId: string): Promise<{ notifications: unknown[] }> {
    if (!userId) throw new UnauthorizedException('missing identity');
    const rows = await this.em.fork().find(
      Notification,
      { userId },
      { orderBy: { createdAt: 'desc' }, limit: 50 },
    );
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        template_id: n.templateId,
        title: n.renderedTitle,
        body: n.renderedBody,
        read_at: n.readAt,
        created_at: n.createdAt,
      })),
    };
  }

  @Post(':id/read')
  @HttpCode(204)
  async markRead(@Headers('x-user-id') userId: string, @Param('id') id: string): Promise<void> {
    if (!userId) throw new UnauthorizedException('missing identity');
    const em = this.em.fork();
    const n = await em.findOne(Notification, { id, userId });
    if (n && !n.readAt) {
      n.readAt = new Date();
      await em.flush();
    }
  }

  /**
   * SSE stream of live in-app notifications for the caller. A heartbeat comment
   * keeps intermediaries from closing an idle connection.
   */
  @Sse('stream')
  stream(@Headers('x-user-id') userId: string, @Res({ passthrough: true }) res: Response): Observable<{ data: LiveNotification } | { data: string }> {
    if (!userId) throw new UnauthorizedException('missing identity');
    res.setHeader('X-Accel-Buffering', 'no');
    const heartbeat = new Observable<{ data: string }>((sub) => {
      const t = setInterval(() => sub.next({ data: 'keepalive' }), 25_000);
      return () => clearInterval(t);
    });
    return merge(this.hub.forUser(userId), heartbeat.pipe(map((h) => h)));
  }
}
