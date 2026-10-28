import { Module } from '@nestjs/common';
import { BooksController } from './books.controller';

@Module({
  controllers: [BooksController],
  providers: [],
})
export class BooksModule {}
