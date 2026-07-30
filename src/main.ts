import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { TcpServerService } from './protocol-gateway/tcp-server.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  app.useStaticAssets(join(__dirname, '..', 'public')); // monitor web en /

  const httpPort = parseInt(process.env.HTTP_PORT ?? '3000', 10);
  await app.listen(httpPort);
  Logger.log(`API + monitor web en http://localhost:${httpPort}`, 'DISMAP');

  // Servidor TCP para los GPS (ST-901 vía protocolo H02)
  app.get(TcpServerService).listen();
}
bootstrap();
