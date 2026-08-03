import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { DatabaseExceptionFilter } from './common/database-exception.filter';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(helmet());
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Unknown fields are an error rather than silently dropped, so a client
      // trying to set something like is_unauthorised is told plainly.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new DatabaseExceptionFilter());

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`TankerTrack API listening on :${env.PORT}/api/v1`);
}

bootstrap().catch((error: unknown) => {
  // A failure here is almost always a missing database or bad config. Exit
  // loudly rather than leaving a half-started process accepting requests.
  // eslint-disable-next-line no-console
  console.error('Failed to start TankerTrack API:', error);
  process.exit(1);
});
