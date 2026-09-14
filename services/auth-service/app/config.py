"""
CloudVault — Auth Service Configuration
"""

import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # MySQL
    MYSQL_ROOT_PASSWORD: str = "cloudvault_mysql_root_2026"
    MYSQL_DATABASE: str = "cloudvault"
    MYSQL_USER: str = "cloudvault"
    MYSQL_PASSWORD: str = "cloudvault_pass"
    MYSQL_HOST: str = "mysql"
    MYSQL_PORT: int = 3306

    # Redis
    REDIS_PASSWORD: str = "cloudvault_redis_2026"
    REDIS_HOST: str = "redis"
    REDIS_PORT: int = 6379

    # JWT
    JWT_SECRET_KEY: str = "cloudvault-jwt-secret-key-change-me-in-production-2026"
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # Kafka
    KAFKA_BOOTSTRAP_SERVERS: str = "kafka:29092"
    KAFKA_TOPIC_USER_EVENTS: str = "user-events"

    @property
    def database_url(self) -> str:
        return (
            f"mysql+asyncmy://{self.MYSQL_USER}:{self.MYSQL_PASSWORD}"
            f"@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DATABASE}"
        )

    @property
    def redis_url(self) -> str:
        return f"redis://:{self.REDIS_PASSWORD}@{self.REDIS_HOST}:{self.REDIS_PORT}/0"

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
