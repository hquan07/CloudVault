# 🏛️ CloudVault Architecture

This document provides a detailed breakdown of the CloudVault system architecture, as represented in the interactive System Topology dashboard. The system is designed using a multi-layered, event-driven microservices approach.

## 📊 System Diagram

```mermaid
graph TD
    %% Layer 1
    User(("End User (Client)"))

    %% Layer 1.5
    Nginx["Nginx LB (Reverse Proxy)"]

    %% Layer 2
    Web["Next.js App (Web Application)"]

    %% Layer 3
    subgraph Frontend Components
        FilePreview["File Preview (UI Component)"]
        ShareUI["Share UI (UI Component)"]
        AuthCtx["Auth State (React Context)"]
        Notif["Notifications (UI Component)"]
    end

    %% Layer 4
    API["API Client (Axios/Fetch)"]

    %% Layer 5
    subgraph Core Microservices (FastAPI)
        Auth["Auth Service"]
        Files["File Service"]
        Meta["Metadata Service"]
    end

    %% Layer 6
    Kafka{"Apache Kafka (Message Broker)"}
    Redis[("Redis (Cache & Pub/Sub)")]

    %% Layer 7
    subgraph Asynchronous Workers (Python)
        AuditW["Audit Logger"]
        ZipW["ZIP Extractor"]
        ThumbW["Thumbnail Gen"]
        SearchW["Search Indexer"]
    end

    %% Layer 8
    MySQL[("MySQL (Relational DB)")]
    MinIO[("MinIO (Object Storage)")]
    ES[("Elasticsearch (Search Engine)")]

    %% Connections
    User -->|HTTP/s| Nginx
    Nginx -->|Proxy| Web
    Nginx -->|API Routing| API

    %% Web to internal
    Web -.-> AuthCtx
    Web -->|Requests| API
    AuthCtx -->|Auth State| API
    FilePreview -->|Download| API
    ShareUI -->|Sharing| API
    Notif -.->|Receives Updates| Redis

    %% API to Services
    API -->|REST| Auth
    API -->|REST| Files
    API -->|REST| Meta

    %% Auth Service Connections
    Auth -->|R/W| MySQL
    Auth -.->|Blacklist| Redis

    %% File Service Connections
    Files -->|R/W| MySQL
    Files -->|Store Objects| MinIO
    Files ==>|Publish Events| Kafka

    %% Meta Service Connections
    Meta -->|R/W| MySQL
    Meta -->|Query| ES
    Meta -.->|Cache| Redis

    %% Kafka to Workers
    Kafka -->|Consume| AuditW
    Kafka -->|Consume| ZipW
    Kafka -->|Consume| ThumbW
    Kafka -->|Consume| SearchW

    %% Worker Connections
    AuditW -->|Write Audit| MySQL
    ZipW -->|Read/Store| MinIO
    ZipW -->|Write Records| MySQL
    ThumbW -->|Read/Store| MinIO
    ThumbW -->|Update| MySQL
    ThumbW -.->|Notify| Redis
    SearchW -->|Read Content| MinIO
    SearchW -->|Index| ES
    SearchW -.->|Notify| Redis
```

## 📡 Topology Overview

### Layer 1: End User (Client)
- **End User:** The entry point to the system, interacting via web browsers.

### Layer 1.5: API Gateway / Load Balancer
- **Nginx LB:** Acts as a reverse proxy, routing incoming HTTP and WebSocket traffic to the appropriate downstream services.

### Layer 2: Web Application
- **Next.js App:** The primary frontend web application handling Server-Side Rendering (SSR) and Client-Side Routing.

### Layer 3: Frontend Components & Context
- **File Preview:** UI component for rendering files (images, videos, audio) directly in the browser.
- **Share UI:** UI component for managing file and folder sharing permissions.
- **Auth State (React Context):** Manages user authentication state globally across the frontend.
- **Notifications:** Manages WebSocket connections for real-time toast notifications.

### Layer 4: API Client
- **API Gateway/Client:** Centralized Axios/Fetch client in the frontend (`api.ts`) that communicates with the backend services.

### Layer 5: Core Microservices (FastAPI)
- **Auth Service:** Handles JWT generation, validation, and user registration/login.
- **File Service:** Manages direct integration with MinIO for file uploads (chunked), downloads, and storage operations.
- **Metadata Service:** Manages file/folder structures, sharing permissions, and database operations.

### Layer 6: Event Bus & Caching
- **Apache Kafka:** The central message broker handling high-throughput, asynchronous events (`file-events`, `user-events`).
- **Redis:** Used for token blacklisting (caching) and as a Pub/Sub message broker for real-time WebSocket notifications.

### Layer 7: Asynchronous Workers (Python)
- **Audit Logger:** Consumes Kafka events to record user actions into the MySQL database.
- **ZIP Extractor:** Consumes Kafka events to extract uploaded ZIP files directly into MinIO and updates metadata in MySQL.
- **Thumbnail Gen:** Consumes Kafka events to generate image thumbnails, stores them in MinIO, and publishes notification events to Redis.
- **Search Indexer:** Consumes Kafka events to parse file content (from MinIO) and index it into Elasticsearch for fast querying.

### Layer 8: Persistence & Search Databases
- **MySQL:** The primary relational database storing users, metadata, file versions, and audit logs.
- **MinIO:** S3-compatible object storage for storing raw files, thumbnails, and avatars.
- **Elasticsearch:** The search engine powering full-text search capabilities across all files.

---

## 🔄 Data & Event Flows

### 1. Request Flow (Synchronous)
1. The **End User** sends a request (HTTP/s).
2. **Nginx** proxies the request to the **Next.js App** (for UI) or directly to the **API Client**.
3. The **API Client** sends REST requests to one of the Core Microservices (**Auth**, **File**, or **Metadata**).
4. The services perform synchronous Reads/Writes to **MySQL** and **MinIO**.

### 2. Event-Driven Flow (Asynchronous)
1. When an action occurs (e.g., a file is uploaded), the **File Service** publishes an event to **Kafka**.
2. **Workers** (Thumbnail Gen, Search Indexer, ZIP Extractor, Audit Logger) independently consume these events.
3. Workers perform their heavy tasks (e.g., reading from MinIO, indexing to Elasticsearch, writing to MySQL).
4. Once completed, workers (like Thumbnail Gen or Search Indexer) publish a success event to **Redis Pub/Sub**.
5. The **Metadata Service** (WebSocket server) receives the Redis message and pushes a real-time **Notification** to the connected **Frontend Client**.

### 3. Caching & Auth Flow
1. **Auth Service** verifies credentials against **MySQL**.
2. For logout, tokens are blacklisted in **Redis**.
3. Other services quickly verify JWT validity without querying MySQL by checking the stateless signature, relying on **Redis** only for blacklisted tokens.

---
*Generated based on the internal `ArchitectureTab.jsx` visual topology.*
