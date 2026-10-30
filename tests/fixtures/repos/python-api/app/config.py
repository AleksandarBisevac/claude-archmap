"""Settings and shared clients (fictional test fixture)."""
import os

import boto3
import redis

DATABASE_URL = os.environ["DATABASE_URL"]
DEBUG = os.environ.get("APP_DEBUG", "0") == "1"
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

cache = redis.Redis.from_url(REDIS_URL)
covers = boto3.client("s3", endpoint_url=os.environ["OBJECT_STORE_URL"])
