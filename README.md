# ☁️ CloudVault — Modern Personal Cloud Storage Platform

[![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.109+-009688.svg)](https://fastapi.tiangolo.com/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A **production-grade, self-hosted personal cloud storage platform** built with microservices architecture, event-driven design, and modern DevOps practices. Designed to be a scalable, open-source alternative to Google Drive or Dropbox.

> **Current Status**: ✅ All 6 Phases Complete — 17 Docker containers, 3 microservices, Next.js frontend, Grafana monitoring

---

## ✨ Key Features

- **Unlimited Object Storage:** Powered by MinIO (S3-compatible) with multi-part chunked upload support for large files.
- **Enterprise-Grade Security:** JWT-based stateless authentication, bcrypt password hashing, and role-based access.
- **Advanced File Sharing:** Generate secure public links with optional password protection, download limits, and expiration dates.
- **Blazing Fast Search:** Elasticsearch integration with edge n-gram analysis for instant full-text search and autocomplete.
- **Event-Driven Architecture:** Apache Kafka streams for asynchronous processing (thumbnail generation, indexing, audit logging).
- **Comprehensive Audit Trail:** Real-time logging of all user and file activities for security and analytics.
- **Beautiful UI (WIP):** A premium Next.js 14 frontend featuring glassmorphism, dark/light modes, and drag-and-drop capabilities.

---

## 🏗️ Architecture

CloudVault relies on a distributed microservices pattern communicating synchronously via REST APIs and asynchronously via Apache Kafka.

```text
┌─────────────────────────┐
│       Frontend          │
│    React / Next.js      │
└───────────┬─────────────┘
            │ HTTP/REST
            ▼
┌─────────────────────────┐
│   API Gateway (Nginx)   │
│   Rate Limit / Routing  │
└───────┬───────┬──────┬──┘
        │       │      │
        ▼       ▼      ▼
    ┌──────┐┌──────┐┌──────┐
    │ Auth ││ File ││ Meta │  ← FastAPI Microservices
    └───┬──┘└───┬──┘└───┬──┘
        │       │       │    ┌──────────────────┐
        ▼       ▼       ▼    │ Thumbnail Worker │
    ┌──────┐┌──────┐┌──────┐ │ Search Indexer   │ ← Kafka Consumers
    │MySQL ││MinIO ││Kafka │◄┤ Audit Logger     │
    │Redis ││      ││  ES  │ └──────────────────┘
    └──────┘└──────┘└──────┘
```

---

## 🛠️ Tech Stack

| Domain | Technology | Purpose |
|--------|-----------|---------|
| **Frontend** | Next.js 14, React, TypeScript | UI and client-side logic |
| **Backend** | Python, FastAPI, SQLAlchemy | High-performance async microservices |
| **Database** | MySQL 8.0, asyncmy | Relational data persistence |
| **Cache & Tokens** | Redis 7 | JWT blacklisting, rate limiting |
| **Object Storage** | MinIO | S3-compatible file/thumbnail storage |
| **Message Broker**| Apache Kafka, Zookeeper | Async event streaming (`file-events`) |
| **Search Engine** | Elasticsearch 8.11 | Full-text search and autocomplete |
| **Monitoring** | Prometheus + Grafana | System metrics and visualization |
| **Routing** | Nginx | Reverse proxy and API gateway |

---

## 🚀 Quick Start

### Prerequisites
- Docker & Docker Compose v2+
- Node.js 18+ (for frontend)
- Python 3.11+ (for testing/scripts)

### 1. Start Infrastructure & Backend
```bash
# Clone the repository
git clone https://github.com/yourusername/cloudvault.git
cd cloudvault

# Copy environment config
cp .env.example .env

# Start all infrastructure and backend services (17 containers)
docker compose up -d

# Verify all services are running
docker compose ps
```

### 2. Start Frontend (Development)
```bash
cd frontend
npm install
npm run dev
```
Access the application at: **[http://localhost:3000](http://localhost:3000)**

---

## 🔌 Service Port Registry

When running locally via Docker Compose, services are mapped to the following ports:

| Service / Container | Port | Description | Credentials (if applicable) |
|---------------------|------|-------------|----------------------------|
| **Next.js Frontend**| `3000` | User Interface | — |
| **Auth Service** | `8001` | User registration & JWT auth | — |
| **File Service** | `8002` | File upload, download & storage | — |
| **Metadata Service**| `8003` | Metadata CRUD, sharing & search | — |
| **MinIO API** | `9000` | S3 API Endpoint | `cloudvault_admin` / `cloudvault_minio_2026` |
| **MinIO Console** | `9001` | Storage Web UI | `cloudvault_admin` / `cloudvault_minio_2026` |
| **Elasticsearch** | `9200` | Search API | — |
| **Kafka UI** | `8080` | Kafka Cluster Management | — |
| **Grafana** | `3001` | Metrics Dashboard | `admin` / `cloudvault_grafana_2026` |
| **Prometheus** | `9090` | Time-series metrics | — |
| **MySQL** | `3306` | Relational Database | `root` / `cloudvault_mysql_root_2026` |
| **Redis** | `6379` | In-memory Cache | — |

---

## 🗺️ Project Roadmap

- [x] **Phase 1: Foundation** — Docker infrastructure (MySQL, Redis, MinIO, Kafka, ES)
- [x] **Phase 2: Auth Service** — JWT registration, login, token blacklisting via Redis
- [x] **Phase 3: File Service** — MinIO integration, chunked uploads, presigned URL downloads
- [x] **Phase 4: Metadata & Workers** — Sharing API, ES search indexer, activity logger, thumbnail generator
- [x] **Phase 5: Frontend** — Next.js 14 App Router UI, file browser, upload dropzone, glassmorphism design
- [x] **Phase 6: Polish & Deploy** — Prometheus metrics, Grafana dashboards, CI/CD, demo seed script

---

## 🧪 Testing

The project includes an end-to-end Python test suite that validates the entire backend pipeline.

```bash
# Install test dependencies
pip install requests

# Run the Phase 4 End-to-End Test Suite
python scripts/test_phase4.py
```

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.