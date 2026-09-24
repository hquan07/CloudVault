# ☁️ CloudVault — Modern Personal Cloud Storage Platform

[![Python](https://img.shields.io/badge/Python-3.11+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.109+-009688.svg)](https://fastapi.tiangolo.com/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg)](https://www.docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A **production-grade, self-hosted personal cloud storage platform** built with microservices architecture, event-driven design, and modern DevOps practices. Designed to be a scalable, open-source alternative to Google Drive or Dropbox.

> **Current Status**: ✅ 100% Core Features & UI/UX Polish Complete. Fully functional with Real-time Notifications, Admin Analytics, File Versioning, and a stunning UI. 22 Docker containers running in harmony!

---

## ✨ Key Features

### 🌟 Core Capabilities
- **Unlimited Object Storage:** Powered by MinIO (S3-compatible) with multi-part chunked upload support for large files.
- **Enterprise-Grade Security:** JWT-based stateless authentication, bcrypt password hashing, and role-based access.
- **Advanced File Sharing:** Generate secure public links with role-based access (View/Edit).
- **File Versioning:** Automatically tracks versions when files are overwritten, allowing seamless restoration via the UI.
- **Event-Driven Architecture:** Apache Kafka streams for asynchronous processing (thumbnail generation, indexing, audit logging).
- **Blazing Fast Search:** Elasticsearch integration with edge n-gram analysis for instant full-text search.

### ✨ Premium UI/UX
- **In-App File Preview:** Instantly preview Images, Videos, and Audio without downloading.
- **Dynamic Views & Layouts:** Toggle between Grid and List views with beautiful, buttery-smooth Framer Motion crossfade animations.
- **Smart Drag & Drop:** Dropzone overlays for intuitive recursive folder uploads.
- **Real-Time Notifications:** WebSockets + Redis Pub/Sub deliver instant toast notifications for background events (e.g., file shared, upload completed).
- **Rich Visuals:** Empty state illustrations, dynamic file type icons, and dark-mode glassmorphism design.

### 🚀 Admin & Analytics
- **Admin Statistics Dashboard:** Real-time system monitoring with interactive Recharts (File Type Distribution, Upload Trends, Top Users).
- **Comprehensive Audit Trail:** Real-time logging of all user and file activities for security and compliance.

---

## 🏗️ Architecture

CloudVault relies on a distributed microservices pattern communicating synchronously via REST APIs and asynchronously via Apache Kafka.

```text
┌─────────────────────────┐
│       Frontend          │
│    React / Next.js      │
└───────────┬─────────────┘
            │ HTTP/REST/WS
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
    │Redis ││      ││  ES  │ │ Zip Extractor    │
    └──────┘└──────┘└──────┘ └──────────────────┘
```

---

## 🛠️ Tech Stack

| Domain | Technology | Purpose |
|--------|-----------|---------|
| **Frontend** | Next.js 14, React, TypeScript | UI, Client-side logic, Framer Motion animations |
| **Backend** | Python, FastAPI, SQLAlchemy | High-performance async microservices |
| **Database** | MySQL 8.0, asyncmy | Relational data persistence (Users, Metadata, Versions) |
| **Cache & Pub/Sub**| Redis 7 | JWT blacklisting, WebSockets Real-time Pub/Sub |
| **Object Storage** | MinIO | S3-compatible file and version storage |
| **Message Broker**| Apache Kafka, Zookeeper | Async event streaming (`file-events`, `user-events`) |
| **Search Engine** | Elasticsearch 8.11, Kibana | Full-text search and management |
| **Monitoring** | Prometheus, Grafana, Jaeger | Metrics, visualization, and distributed tracing |
| **Routing** | Nginx | Reverse proxy, API gateway, WebSocket proxy |

---

## 🚀 Quick Start

### Prerequisites
- Docker & Docker Compose v2+
- Node.js 18+ (for frontend)
- Python 3.11+ (for testing/scripts)

### 1. Start Infrastructure & Backend
```bash
# Clone the repository
git clone https://github.com/hquan07/CloudVault.git
cd CloudVault

# Start all infrastructure and backend services (22 containers)
docker compose up -d --build

# Verify all services are running
docker compose ps
```

### 2. Start Frontend
```bash
# The frontend is fully containerized in the docker-compose setup.
# If you wish to run it locally for development instead:
cd frontend
npm install
npm run dev
```
Access the application at: **[http://localhost:3000](http://localhost:3000)**

---

## 🔌 Service Port Registry

When running locally via Docker Compose, services are mapped to the following ports:

| Service / Container | Port | Description | 
|---------------------|------|-------------|
| **Next.js Frontend**| `3000` | User Interface |
| **Auth Service** | `8001` | User registration & JWT auth | 
| **File Service** | `8002` | File upload, download & storage |
| **Metadata Service**| `8003` | Metadata CRUD, sharing & search | 
| **MinIO API** | `9000` | S3 API Endpoint | 
| **MinIO Console** | `9001` | Storage Web UI | 
| **Elasticsearch** | `9200` | Search API | 
| **Kibana** | `5601` | Search UI |
| **Kafka UI** | `8080` | Kafka Cluster Management |
| **Grafana** | `3001` | Metrics Dashboard |
| **Prometheus** | `9090` | Time-series metrics | 
| **Jaeger** | `16686`| Distributed Tracing UI | 
| **MySQL** | `3306` | Relational Database |
| **Redis** | `6379` | In-memory Cache |

---

## 🧪 Testing

The project includes an end-to-end Python test suite that validates the entire backend pipeline.

```bash
# Install test dependencies
pip install requests

# Run the End-to-End Test Suite
python scripts/test_phase4.py
```

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.
