import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, getRepository, Repository } from 'typeorm';
import { Author } from '../entities/author.entity';
import { Book } from '../entities/book.entity';

@Injectable()
export class CatalogRepo {
  constructor(
    @InjectRepository(Book) private readonly books: Repository<Book>,
    private readonly dataSource: DataSource,
  ) {}

  all() {
    return this.books.find();
  }

  byId(id: string) {
    return this.books.findOneBy({ id });
  }

  store(book: Book) {
    return this.books.save(book);
  }

  add(title: string) {
    return this.books.insert({ title });
  }

  retitle(id: string, title: string) {
    return this.books.update(id, { title });
  }

  remove(id: string) {
    return this.books.delete(id);
  }

  authors() {
    return this.dataSource.getRepository(Author).find();
  }

  unknown() {
    return this.dataSource.getRepository(Mystery).find();
  }
}

export async function legacy() {
  const repo = getRepository(Author);
  return repo.save({ name: 'x' });
}
