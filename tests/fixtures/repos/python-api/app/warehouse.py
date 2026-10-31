"""File databases opened by path (fictional test fixture; neither file is in the repository)."""
import duckdb
import sqlite3

REPORTS = duckdb.connect("data/reports.duckdb")
LOCAL_CACHE = sqlite3.connect('var/cache.sqlite3')


def read_only():
    return duckdb.connect(database="data/archive.duckdb", read_only=True)
