import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  readonly client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // si Redis está caído, fallar rápido: nunca encolar
    commandTimeout: 2000,
  });

  constructor() {
    this.client.on('error', (err) => this.logger.warn(`Redis: ${err.message}`));
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
