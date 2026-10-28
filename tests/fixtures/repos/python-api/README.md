# python-api (test fixture)

This directory is a **test fixture** for `scripts/lib/prescan/python.mjs`. It is not a real application.
Everything in it is fictional (a made-up bookshop), nothing here is meant to be run, and the files are only
ever read as text by the pre-scan tests.

`app/sidefx.py` is a canary: importing it would write `EXECUTED.txt` and raise. The tests assert the
extractor never does.

One realistic example of each pattern the Python extractor looks for:

| Pattern | File |
| --- | --- |
| FastAPI routes | `app/main.py` |
| Flask routes | `app/admin.py` |
| Django url routes | `shop/urls.py` |
| SQLAlchemy entities | `app/models.py` |
| Django entities | `shop/models.py` |
| Pydantic schemas | `app/schemas.py` |
| Alembic migrations | `migrations/versions/` |
| Raw SQL table names | `app/reports.py` |
| Outbound HTTP calls | `app/clients.py` |
