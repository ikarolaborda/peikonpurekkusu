import { Injectable } from '@nestjs/common';
import { Subject, filter, map, Observable } from 'rxjs';

export interface LiveNotification {
  userId: string;
  id: string;
  title: string;
  body: string;
  channel: string;
  createdAt: string;
}

/**
 * In-process pub/sub feeding the per-user SSE stream. Single-replica scope by
 * design; a multi-replica deployment swaps this for Redis pub/sub behind the
 * same interface.
 */
@Injectable()
export class SseHub {
  private readonly stream = new Subject<LiveNotification>();

  publish(n: LiveNotification): void {
    this.stream.next(n);
  }

  forUser(userId: string): Observable<{ data: LiveNotification }> {
    return this.stream.asObservable().pipe(
      filter((n) => n.userId === userId),
      map((n) => ({ data: n })),
    );
  }
}
