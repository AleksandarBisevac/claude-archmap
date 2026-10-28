import { NestFactory } from '@nestjs/core';
import { BooksModule } from './books/books.module';

async function bootstrap() {
  const app = await NestFactory.create(BooksModule);
  app.setGlobalPrefix('api/v1');
  await app.listen(3000);
}

bootstrap();
