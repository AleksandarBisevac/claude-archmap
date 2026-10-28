import { All, Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';

const SEARCH_PATH = ['search', 'find'];

@Controller('books')
export class BooksController {
  @Get()
  list() {
    return [];
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  @Post()
  create(@Body() dto: { title: string }) {
    return dto;
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: { title: string }) {
    return { id, ...dto };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { id };
  }

  @Get(['featured', 'bestsellers'])
  highlights() {
    return [];
  }

  @All('ping')
  ping() {
    return 'pong';
  }

  @Get(SEARCH_PATH)
  search() {
    return [];
  }
}
