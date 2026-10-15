"""
CloudVault — Metadata Service Configuration
"""

import os
from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # MySQL
    MYSQL_DATABASE: str = "cloudvault"
    MYSQL_USER: str = "cloudvault"
    MYSQL_PASSWORD: str = Field(min_length=32)
    MYSQL_HOST: str = "mysql"
    MYSQL_PORT: int = 3306
    DB_POOL_SIZE: int = Field(default=10, ge=1, le=100)
    DB_MAX_OVERFLOW: int = Field(default=5, ge=0, le=100)
    DB_POOL_RECYCLE_SECONDS: int = Field(default=1800, ge=60)

    # Redis
    REDIS_PASSWORD: str = Field(min_length=32)
    REDIS_HOST: str = "redis"
    REDIS_PORT: int = 6379

    # Elasticsearch
    ELASTICSEARCH_URL: str = "http://elasticsearch:9200"
    ELASTICSEARCH_USERNAME: str = "cloudvault_app"
    ELASTICSEARCH_APP_PASSWORD: str = Field(min_length=32)

    # JWT (for token verification)
    JWT_SECRET_KEY: str = Field(min_length=32)
    JWT_ALGORITHM: str = "HS256"

    # MinIO (for presigned URLs)
    MINIO_ENDPOINT: str = "minio:9000"
    MINIO_PUBLIC_ENDPOINT: str = "localhost:9000"
    MINIO_ROOT_USER: str = "cloudvault_admin"
    MINIO_ROOT_PASSWORD: str = Field(min_length=32)
    MINIO_BUCKET_FILES: str = "cloudvault-files"

    # Browser origins allowed only for direct API development.
    CORS_ALLOWED_ORIGINS: str = "http://localhost,http://localhost:3000,http://127.0.0.1,http://127.0.0.1:3000"

    # Kafka
    KAFKA_BOOTSTRAP_SERVERS: str = "kafka:29092"
    KAFKA_TOPIC_FILE_EVENTS: str = "file-events"
    KAFKA_TOPIC_DEAD_LETTER: str = "dead-letter-events"

    @property
    def database_url(self) -> str:
        return (
            f"mysql+asyncmy://{self.MYSQL_USER}:{self.MYSQL_PASSWORD}"
            f"@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DATABASE}"
        )

    @property
    def redis_url(self) -> str:
        return f"redis://:{self.REDIS_PASSWORD}@{self.REDIS_HOST}:{self.REDIS_PORT}/0"

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ALLOWED_ORIGINS.split(",") if origin.strip()]

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "ignore"


settings = Settings()
