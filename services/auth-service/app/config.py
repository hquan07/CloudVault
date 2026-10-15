"""
CloudVault — Auth Service Configuration
"""

import os
from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Optional, explicit bootstrap identity. Leave empty in environments that
    # provision administrators through their own identity-management process.
    BOOTSTRAP_ADMIN_EMAIL: str = ""

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

    # JWT
    JWT_SECRET_KEY: str = Field(min_length=32)
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    # Use a dedicated random value in production. Empty keeps local upgrades
    # compatible by deriving an encryption key from JWT_SECRET_KEY.
    MFA_ENCRYPTION_KEY: str = ""

    # Authentication abuse protection. Limits are per client/identity pair.
    AUTH_RATE_LIMIT_WINDOW_SECONDS: int = Field(default=60, ge=10, le=3600)
    AUTH_LOGIN_ATTEMPTS_PER_WINDOW: int = Field(default=5, ge=1, le=100)
    AUTH_REGISTER_ATTEMPTS_PER_WINDOW: int = Field(default=3, ge=1, le=100)
    AUTH_REFRESH_ATTEMPTS_PER_WINDOW: int = Field(default=20, ge=1, le=500)

    # Browser origins allowed only for direct API development. Production UI
    # uses same-origin requests through Nginx.
    CORS_ALLOWED_ORIGINS: str = "http://localhost,http://localhost:3000,http://127.0.0.1,http://127.0.0.1:3000"

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

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ALLOWED_ORIGINS.split(",") if origin.strip()]

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "ignore"


settings = Settings()
