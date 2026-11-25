import { Redis } from 'ioredis';
import { config } from './config.js';

let _redis: Redis | undefined;
let _sub: Redis | undefined; // dedicated subscriber connection

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
  }
  return _redis;
}

/** A separate Redis connection used exclusively for SUBSCRIBE/PSUBSCRIBE. */
export function getSubRedis(): Redis {
  if (!_sub) {
    _sub = new Redis(config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
  }
  return _sub;
}

/** Wait until Redis is ready (resolves immediately if already ready). */
export async function waitRedisReady(): Promise<void> {
  const r = getRedis();
  if ((r.status as string) === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    r.once('ready', resolve);
    r.once('error', reject);
  });
}
