import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { authRoutes } from './routes/auth.js';
import { clientRoutes } from './routes/clients.js';
import { quoteRoutes } from './routes/quotes.js';
import { orderRoutes } from './routes/orders.js';
import { userRoutes } from './routes/users.js';
import { locationRoutes } from './routes/locations.js';
import { departmentRoutes } from './routes/departments.js';
import { metaRoutes } from './routes/meta.js';

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : true,
    })
  );
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/auth', authRoutes);
  app.use('/clients', clientRoutes);
  app.use('/quotes', quoteRoutes);
  app.use('/orders', orderRoutes);
  app.use('/users', userRoutes);
  app.use('/locations', locationRoutes);
  app.use('/departments', departmentRoutes);
  app.use('/meta', metaRoutes);

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // Central error handler. Honours err.status when a route sets one.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'server error' });
  });

  return app;
}
