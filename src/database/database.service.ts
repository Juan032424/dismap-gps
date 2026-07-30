import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, QueryResult } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  readonly pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://postgres:cambiame@localhost:5432/dismap',
  });

  constructor() {
    this.pool.on('error', (err) => this.logger.error(`Pool PG: ${err.message}`));
  }

  query(text: string, params?: unknown[]): Promise<QueryResult> {
    return this.pool.query(text, params as any[]);
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}
