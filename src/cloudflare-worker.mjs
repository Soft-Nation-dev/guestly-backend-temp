import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import mongoose from 'mongoose';

let gatewayPromise;
let connectionPromise;

async function connectDatabase(uri) {
  if (!uri) throw new Error('MongoDB connection is missing');
  if (mongoose.connection.readyState === 1) return;
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(uri, {
      maxPoolSize: 1,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
      maxIdleTimeMS: 20000,
    }).finally(() => {
      connectionPromise = null;
    });
  }
  await connectionPromise;
}

async function gateway() {
  if (!gatewayPromise) {
    gatewayPromise = import('./app.js').then(({ default: app }) => httpServerHandler(createServer(app)))
      .catch(error => {
        gatewayPromise = null;
        throw error;
      });
  }
  return gatewayPromise;
}

async function runSchedule(cron) {
  if (cron === '*/5 * * * *') {
    const { expirePendingBookings } = await import('./jobs/expireBookings.js');
    await expirePendingBookings(20);
  } else if (cron === '0 2 * * *') {
    const { purgeDocuments } = await import('./jobs/purgeCheckinDocuments.js');
    await purgeDocuments();
  } else if (cron === '15 12 * * *') {
    const { reconcileAll } = await import('./modules/loyalty/service.js');
    await reconcileAll();
  }
}

export default {
  async fetch(request, env, context) {
    try {
      if (new URL(request.url).pathname !== '/health') await connectDatabase(env.MONGODB_URI);
      const handler = await gateway();
      return await handler.fetch(request, env, context);
    } catch (error) {
      console.error('Guestly Worker request failed', error);
      return Response.json({ success: false, message: 'Service temporarily unavailable' }, { status: 503 });
    }
  },
  async scheduled(controller, env, context) {
    context.waitUntil((async () => {
      try {
        await connectDatabase(env.MONGODB_URI);
        await runSchedule(controller.cron);
      } catch (error) {
        console.error('Guestly scheduled job failed', error.message);
        throw error;
      }
    })());
  },
};
