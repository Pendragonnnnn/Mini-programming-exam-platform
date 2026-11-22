import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import express from 'express';
import { config } from './config';
import { errorMiddleware, notFound } from './errors';
import { authRouter } from './routes/auth';
import { bankRouter } from './routes/bank';
import { gradingRouter } from './routes/grading';
import { manageRouter } from './routes/manage';
import { sharedRouter } from './routes/shared';
import { studentRouter } from './routes/student';
import { teacherRouter } from './routes/teacher';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.requestId = 'req_' + crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Server-Time', new Date().toISOString());
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  if (config.corsOrigin) {
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Exam-Session');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'X-Server-Time, Content-Disposition');
      if (req.method === 'OPTIONS') return res.status(204).end();
      next();
    });
  }
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use('/auth', authRouter);
  api.use(sharedRouter);
  api.use(studentRouter);
  api.use(teacherRouter);
  api.use(bankRouter);
  api.use(gradingRouter);
  api.use(manageRouter);
  api.use((_req, _res, next) => next(notFound('NOT_FOUND', 'Unknown API route.')));
  app.use('/api', api);
  app.use(errorMiddleware);
  return app;
}
