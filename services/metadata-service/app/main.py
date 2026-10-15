"""
CloudVault — Metadata Service Main Application

Endpoints matching the frontend api.ts contract:
  GET    /api/v1/metadata/files           — list files (with filters)
  GET    /api/v1/metadata/files/:id       — get single file
  PUT    /api/v1/metadata/files/:id       — update file (rename, star)
  GET    /api/v1/metadata/files/:id/versions — list file versions
  GET    /api/v1/metadata/storage         — storage usage
  GET    /api/v1/search/                  — full-text search
  GET    /api/v1/search/suggest           — autocomplete suggestions
  GET    /api/v1/activity                 — activity feed (audit logs)
  POST   /api/v1/share/                   — create share link
  GET    /api/v1/share/access/:token      — access public share
  POST   /api/v1/share/access/:token      — access password-protected share
  GET    /api/v1/share/links/mine         — list my share links
  GET    /api/v1/share/links/file/:id     — list links for a file
  DELETE /api/v1/share/links/:id          — revoke a share link
"""

import secrets
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from typing import Optional
import logging
import os
import uuid

import bcrypt
from minio import Minio
from elasticsearch import AsyncElasticsearch
from fastapi import FastAPI, Depends, HTTPException, status, Query, Body, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc, or_, and_, text
import redis.asyncio as aioredis

from app.config import settings
from app.database import get_db
from app.dependencies import (
    authenticate_token,
    close_auth_dependencies,
    get_current_admin,
    get_current_user,
    init_auth_dependencies,
)
from app.models import (
    User, File, Folder, FileVersion, SharedLink, AuditLog, AnalyticsDaily,
    FolderPermission, Project, ProjectFileStar, ProjectMembership,
)
from app.analytics import build_storage_growth, build_upload_activity, summarize_file_types

# ── Elasticsearch & Redis clients ──
es_client: AsyncElasticsearch | None = None
redis_client: aioredis.Redis | None = None
minio_public_client = Minio(
    settings.MINIO_PUBLIC_ENDPOINT,
    access_key=settings.MINIO_ROOT_USER,
    secret_key=settings.MINIO_ROOT_PASSWORD,
    secure=False,
    region="us-east-1",
)



from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.structs import TopicPartition
from app.database import async_session
import json
import asyncio

notification_consumer_task = None
logger = logging.getLogger(__name__)

async def notification_worker():
    """Forward domain events to Redis; audit persistence is owned by audit-logger."""
    consumer = AIOKafkaConsumer(
        settings.KAFKA_TOPIC_FILE_EVENTS,
        bootstrap_servers=settings.KAFKA_BOOTSTRAP_SERVERS,
        group_id="metadata-notifications",
        client_id=f"metadata-notifications-{os.getenv('HOSTNAME', 'local')}",
        auto_offset_reset="latest",
        enable_auto_commit=False,
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
    )
    dlq = AIOKafkaProducer(
        bootstrap_servers=settings.KAFKA_BOOTSTRAP_SERVERS,
        client_id=f"metadata-notifications-dlq-{os.getenv('HOSTNAME', 'local')}",
        acks="all",
        enable_idempotence=True,
        key_serializer=lambda value: value.encode("utf-8"),
        value_serializer=lambda value: json.dumps(value, default=str).encode("utf-8"),
    )
    await consumer.start()
    await dlq.start()
    try:
        async for msg in consumer:
            data = msg.value
            event_id = str(
                data.get("event_id")
                or uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"kafka:{msg.topic}:{msg.partition}:{msg.offset}",
                )
            )
            data.setdefault("event_id", event_id)
            last_error = None
            max_retries = max(1, int(os.getenv("KAFKA_CONSUMER_MAX_RETRIES", "3")))
            backoff = max(
                0.0, float(os.getenv("KAFKA_CONSUMER_RETRY_BACKOFF_SECONDS", "2"))
            )
            for attempt in range(1, max_retries + 1):
                try:
                    event = data.get("event")
                    user_id = data.get("user_id") or data.get("shared_by")
                    if event and user_id and redis_client:
                        msg_payload = {
                            "type": "activity",
                            "action": event,
                            "resource_name": data.get("filename") or data.get("folder_name") or "",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        }
                        recipients = {user_id}
                        if data.get("shared_with"):
                            recipients.add(data["shared_with"])
                        for recipient in recipients:
                            await redis_client.publish(
                                f"notifications:{recipient}", json.dumps(msg_payload)
                            )
                    last_error = None
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - consumer boundary
                    last_error = error
                    logger.exception(
                        "Notification event %s failed on attempt %s/%s",
                        event_id,
                        attempt,
                        max_retries,
                    )
                    if attempt < max_retries and backoff:
                        await asyncio.sleep(backoff * attempt)

            if last_error is not None:
                await dlq.send_and_wait(
                    settings.KAFKA_TOPIC_DEAD_LETTER,
                    {
                        "event_id": event_id,
                        "event": "DEAD_LETTERED",
                        "failed_consumer_group": "metadata-notifications",
                        "source_topic": msg.topic,
                        "source_partition": msg.partition,
                        "source_offset": msg.offset,
                        "error_type": type(last_error).__name__,
                        "error": str(last_error)[:2000],
                        "original_event": data,
                    },
                    key=event_id,
                )
            await consumer.commit(
                {TopicPartition(msg.topic, msg.partition): msg.offset + 1}
            )
    finally:
        await consumer.stop()
        await dlq.stop()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global es_client, redis_client
    await init_auth_dependencies()
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    es_client = AsyncElasticsearch(
        settings.ELASTICSEARCH_URL,
        basic_auth=(
            settings.ELASTICSEARCH_USERNAME,
            settings.ELASTICSEARCH_APP_PASSWORD,
        ),
    )
    # Ensure the index exists
    try:
        if not await es_client.indices.exists(index="cloudvault-files"):
            await es_client.indices.create(
                index="cloudvault-files",
                body={
                    "settings": {
                        "analysis": {
                            "analyzer": {
                                "edge_ngram_analyzer": {
                                    "type": "custom",
                                    "tokenizer": "edge_ngram_tokenizer",
                                    "filter": ["lowercase"],
                                },
                                "search_analyzer": {
                                    "type": "custom",
                                    "tokenizer": "standard",
                                    "filter": ["lowercase"],
                                },
                            },
                            "tokenizer": {
                                "edge_ngram_tokenizer": {
                                    "type": "edge_ngram",
                                    "min_gram": 2,
                                    "max_gram": 20,
                                    "token_chars": ["letter", "digit"],
                                }
                            },
                        }
                    },
                    "mappings": {
                        "properties": {
                            "filename": {
                                "type": "text",
                                "analyzer": "edge_ngram_analyzer",
                                "search_analyzer": "search_analyzer",
                            },
                            "original_name": {
                                "type": "text",
                                "analyzer": "edge_ngram_analyzer",
                                "search_analyzer": "search_analyzer",
                            },
                            "mime_type": {"type": "keyword"},
                            "user_id": {"type": "keyword"},
                            "project_id": {"type": "keyword"},
                            "folder_id": {"type": "keyword"},
                            "size": {"type": "long"},
                            "is_deleted": {"type": "boolean"},
                            "created_at": {"type": "date"},
                            "updated_at": {"type": "date"},
                        }
                    },
                },
            )
        else:
            await es_client.indices.put_mapping(
                index="cloudvault-files",
                properties={"project_id": {"type": "keyword"}},
            )
    except Exception:
        pass  # ES may not be ready yet; search-indexer will handle it

    global notification_consumer_task
    notification_consumer_task = asyncio.create_task(notification_worker())
    yield
    if es_client:
        await es_client.close()
    if redis_client:
        await redis_client.aclose()
    await close_auth_dependencies()
    if notification_consumer_task:
        notification_consumer_task.cancel()
        with suppress(asyncio.CancelledError):
            await notification_consumer_task


# ── FastAPI App ──

app = FastAPI(
    title="CloudVault Metadata Service",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Instrumentator().instrument(app).expose(app)

from app.telemetry import setup_opentelemetry
setup_opentelemetry(app, "metadata-service")


# ── Helper ──

def _file_to_dict(f: File) -> dict:
    return {
        "id": f.id,
        "filename": f.filename,
        "original_name": f.original_name,
        "mime_type": f.mime_type,
        "size": f.size,
        "folder_id": f.folder_id,
        "user_id": f.user_id,
        "project_id": f.project_id,
        "minio_bucket": f.minio_bucket,
        "minio_key": f.minio_key,
        "checksum_sha256": f.checksum_sha256,
        "thumbnail_key": f.thumbnail_key,
        "current_version": f.current_version,
        "is_starred": f.is_starred,
        "is_deleted": f.is_deleted,
        "deleted_at": f.deleted_at.isoformat() if f.deleted_at else None,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


import asyncio
import json

# ── WebSocket Notifications ──

@app.websocket("/api/v1/metadata/ws/notifications")
async def websocket_notifications(websocket: WebSocket):
    # Browser WebSocket APIs cannot attach an Authorization header. Authenticate
    # with the first frame instead of a query parameter so access tokens never
    # appear in gateway/Uvicorn request logs, browser history, or copied URLs.
    await websocket.accept()
    try:
        auth_message = await asyncio.wait_for(websocket.receive_text(), timeout=5)
        auth_payload = json.loads(auth_message)
        token = auth_payload.get("token") if auth_payload.get("type") == "authenticate" else None
        if not isinstance(token, str) or not token:
            raise ValueError("missing websocket authentication token")
        async with async_session() as session:
            user = await authenticate_token(token, session)
    except (asyncio.TimeoutError, json.JSONDecodeError, ValueError, HTTPException):
        await websocket.close(code=1008)
        return
    
    pubsub = redis_client.pubsub()
    channel = f"notifications:{user.id}"
    await pubsub.subscribe(channel)
    
    async def redis_listener():
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    await websocket.send_text(message["data"])
        except asyncio.CancelledError:
            pass
        except Exception as e:
            pass

    listener_task = asyncio.create_task(redis_listener())
    
    try:
        while True:
            # Wait for disconnect
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        listener_task.cancel()
        await pubsub.unsubscribe(channel)
        await pubsub.close()


# ── Health Check ──

@app.get("/health")
async def health():
    return {"status": "ok", "service": "metadata"}


# ══════════════════════════════════════════════
# METADATA ROUTES
# ══════════════════════════════════════════════

@app.get("/api/v1/metadata/files")
async def list_files(
    folder_id: Optional[str] = Query(None),
    is_starred: Optional[bool] = Query(None),
    is_deleted: Optional[bool] = Query(False),
    mime_type: Optional[str] = Query(None),
    sort_by: str = Query("created_at"),
    sort_order: str = Query("desc"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(File).where(File.user_id == user.id, File.is_deleted == is_deleted)

    if folder_id is not None and folder_id != "root":
        query = query.where(File.folder_id == folder_id)
    elif folder_id == "root" or folder_id is None:
        query = query.where(File.folder_id == None)
    if is_starred is not None:
        query = query.where(File.is_starred == is_starred)
    if mime_type is not None:
        query = query.where(File.mime_type.like(f"{mime_type}%"))

    # Count
    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # Sort
    sort_col = getattr(File, sort_by, File.created_at)
    if sort_order == "asc":
        query = query.order_by(sort_col.asc())
    else:
        query = query.order_by(sort_col.desc())

    # Paginate
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    files = result.scalars().all()

    # Also get folders if not deleted view
    folders = []
    if not is_deleted:
        folder_q = (
            select(Folder)
            .where(Folder.user_id == user.id, Folder.is_deleted == False)
        )
        if folder_id and folder_id != "root":
            folder_q = folder_q.where(Folder.parent_id == folder_id)
        else:
            folder_q = folder_q.where(Folder.parent_id == None)
        folder_q = folder_q.order_by(Folder.name.asc())
        folder_result = await db.execute(folder_q)
        folders = [
            {
                "id": f.id,
                "name": f.name,
                "parent_id": f.parent_id,
                "path": f.path,
                "depth": f.depth,
                "created_at": f.created_at.isoformat() if f.created_at else None,
            }
            for f in folder_result.scalars().all()
        ]

    return {
        "files": [_file_to_dict(f) for f in files],
        "folders": folders,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.get("/api/v1/metadata/files/{file_id}")
async def get_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id)
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")
    return _file_to_dict(f)


@app.put("/api/v1/metadata/files/{file_id}")
async def update_file(
    file_id: str,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id)
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    if "original_name" in body:
        f.original_name = body["original_name"]
    if "is_starred" in body:
        f.is_starred = body["is_starred"]

    await db.commit()
    await db.refresh(f)
    return _file_to_dict(f)


@app.get("/api/v1/metadata/files/{file_id}/versions")
async def get_file_versions(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify file ownership
    f_result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id)
    )
    if not f_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    result = await db.execute(
        select(FileVersion)
        .where(FileVersion.file_id == file_id)
        .order_by(FileVersion.version_number.desc())
    )
    versions = result.scalars().all()
    return {
        "versions": [
            {
                "id": v.id,
                "file_id": v.file_id,
                "version_number": v.version_number,
                "size": v.size,
                "checksum_sha256": v.checksum_sha256,
                "comment": v.comment,
                "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v in versions
        ]
    }


@app.get("/api/v1/metadata/storage")
async def get_storage(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # storage_used tracks physical objects, including retained file versions.
    used = user.storage_used
    return {
        "storage_used": used,
        "storage_quota": user.storage_quota,
        "percentage": round((used / user.storage_quota * 100), 2) if user.storage_quota > 0 else 0,
    }


# ══════════════════════════════════════════════
# USER-SCOPED ANALYTICS
# ══════════════════════════════════════════════

@app.get("/api/v1/analytics/stats")
async def get_analytics_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if user.role == "admin":
        project_ids = select(Project.id)
    else:
        project_ids = select(ProjectMembership.project_id).where(
            ProjectMembership.user_id == user.id
        )
    access_filter = or_(
        and_(File.user_id == user.id, File.project_id.is_(None)),
        File.project_id.in_(project_ids),
    )
    active_filter = and_(access_filter, File.is_deleted.is_(False))

    project_count = await db.scalar(select(func.count()).select_from(project_ids.subquery())) or 0
    total_storage = await db.scalar(
        select(func.coalesce(func.sum(File.size), 0)).where(access_filter)
    ) or 0
    trash_bytes = await db.scalar(
        select(func.coalesce(func.sum(File.size), 0)).where(
            access_filter, File.is_deleted.is_(True)
        )
    ) or 0
    active_files = await db.scalar(
        select(func.count(File.id)).where(active_filter)
    ) or 0

    project_starred_ids = select(ProjectFileStar.file_id).where(
        ProjectFileStar.user_id == user.id
    )
    starred_files = await db.scalar(
        select(func.count(File.id)).where(
            active_filter,
            or_(
                and_(File.project_id.is_(None), File.is_starred.is_(True)),
                File.id.in_(project_starred_ids),
            ),
        )
    ) or 0
    active_shares = await db.scalar(
        select(func.count(func.distinct(SharedLink.id)))
        .select_from(SharedLink)
        .join(File, File.id == SharedLink.file_id)
        .where(
            active_filter,
            SharedLink.is_active.is_(True),
            or_(SharedLink.expires_at.is_(None), SharedLink.expires_at > now),
        )
    ) or 0

    file_type_result = await db.execute(
        select(File.mime_type, func.count(File.id))
        .where(active_filter)
        .group_by(File.mime_type)
    )
    hour_expression = func.date_format(File.created_at, "%Y-%m-%d %H:00:00")
    hourly_result = await db.execute(
        select(hour_expression, func.count(File.id))
        .where(active_filter, File.created_at >= now - timedelta(hours=24))
        .group_by(hour_expression)
        .order_by(hour_expression)
    )
    day_expression = func.date(File.created_at)
    daily_result = await db.execute(
        select(day_expression, func.coalesce(func.sum(File.size), 0))
        .where(access_filter, File.created_at >= now - timedelta(days=6))
        .group_by(day_expression)
        .order_by(day_expression)
    )

    return {
        "generated_at": now.replace(tzinfo=timezone.utc).isoformat(),
        "scope": {"personal": True, "project_count": int(project_count)},
        "cards": {
            "total_storage_bytes": int(total_storage),
            "active_files": int(active_files),
            "starred_files": int(starred_files),
            "active_shares": int(active_shares),
            "trash_bytes": int(trash_bytes),
        },
        "file_types": summarize_file_types(file_type_result.all()),
        "upload_activity": build_upload_activity(hourly_result.all(), now),
        "storage_growth": build_storage_growth(
            int(total_storage), daily_result.all(), now.date()
        ),
    }


# ══════════════════════════════════════════════
# SEARCH ROUTES
# ══════════════════════════════════════════════

@app.get("/api/v1/search/")
async def search_files(
    q: str = Query(..., min_length=1),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    mime_type: Optional[str] = Query(None),
    min_size: Optional[int] = Query(None, ge=0),
    max_size: Optional[int] = Query(None, ge=0),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    sort_by: str = Query("relevance", pattern="^(relevance|created_at|updated_at|size)$"),
    sort_order: str = Query("desc", pattern="^(asc|desc)$"),
    project_id: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = None
    if project_id:
        project_result = await db.execute(
            select(Project).where((Project.id == project_id) | (Project.slug == project_id))
        )
        project = project_result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        if user.role != "admin":
            membership = await db.scalar(select(ProjectMembership).where(
                ProjectMembership.project_id == project.id,
                ProjectMembership.user_id == user.id,
            ))
            if not membership:
                raise HTTPException(status_code=403, detail="Project access denied")

    # Try Elasticsearch first
    if es_client:
        try:
            filters = [{"term": {"is_deleted": False}}]
            must_not = []
            if project:
                filters.append({"term": {"project_id": project.id}})
            else:
                filters.append({"term": {"user_id": user.id}})
                must_not.append({"exists": {"field": "project_id"}})
            if mime_type:
                filters.append({"prefix": {"mime_type": mime_type}})
            if min_size is not None or max_size is not None:
                size_range = {}
                if min_size is not None:
                    size_range["gte"] = min_size
                if max_size is not None:
                    size_range["lte"] = max_size
                filters.append({"range": {"size": size_range}})
            if date_from or date_to:
                date_range = {}
                if date_from:
                    date_range["gte"] = date_from.isoformat()
                if date_to:
                    date_range["lte"] = date_to.isoformat()
                filters.append({"range": {"created_at": date_range}})

            body = {
                "query": {
                    "bool": {
                        "must": [
                            {
                                "multi_match": {
                                    "query": q,
                                    "fields": ["original_name^3", "filename", "content"],
                                    "type": "best_fields",
                                    "fuzziness": "AUTO",
                                }
                            }
                        ],
                        "filter": filters,
                        "must_not": must_not,
                    }
                },
                "from": (page - 1) * page_size,
                "size": page_size,
                "highlight": {
                    "fields": {"original_name": {}, "filename": {}, "content": {}}
                },
            }
            if sort_by != "relevance":
                body["sort"] = [{sort_by: {"order": sort_order}}]
            es_result = await es_client.search(index="cloudvault-files", body=body)
            hits = es_result["hits"]
            total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]

            files = []
            for hit in hits["hits"]:
                src = hit["_source"]
                src["id"] = hit["_id"]
                if "highlight" in hit:
                    src["highlight"] = hit["highlight"]
                if project:
                    src["project_name"] = project.name
                    src["project_slug"] = project.slug
                files.append(src)

            if project and files:
                starred_result = await db.execute(select(ProjectFileStar.file_id).where(
                    ProjectFileStar.user_id == user.id,
                    ProjectFileStar.file_id.in_([item["id"] for item in files]),
                ))
                starred_ids = set(starred_result.scalars().all())
                for item in files:
                    item["is_starred"] = item["id"] in starred_ids

            return {"files": files, "total": total, "page": page, "page_size": page_size}
        except Exception:
            pass  # Fallback to MySQL LIKE search

    # Fallback: MySQL search
    conditions = [
        File.is_deleted == False,
        File.original_name.like(f"%{q}%"),
    ]
    if project:
        conditions.append(File.project_id == project.id)
    else:
        conditions.extend([File.user_id == user.id, File.project_id.is_(None)])
    if mime_type:
        conditions.append(File.mime_type.like(f"{mime_type}%"))
    if min_size is not None:
        conditions.append(File.size >= min_size)
    if max_size is not None:
        conditions.append(File.size <= max_size)
    if date_from:
        conditions.append(File.created_at >= date_from)
    if date_to:
        conditions.append(File.created_at <= date_to)

    sort_column = getattr(File, sort_by, File.updated_at) if sort_by != "relevance" else File.updated_at
    order_clause = sort_column.asc() if sort_order == "asc" else sort_column.desc()
    query = select(File).where(*conditions).order_by(order_clause).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    files = result.scalars().all()
    starred_ids = set()
    if project and files:
        starred_result = await db.execute(select(ProjectFileStar.file_id).where(
            ProjectFileStar.user_id == user.id,
            ProjectFileStar.file_id.in_([item.id for item in files]),
        ))
        starred_ids = set(starred_result.scalars().all())

    count_q = select(func.count()).select_from(
        select(File).where(*conditions).subquery()
    )
    total = (await db.execute(count_q)).scalar() or 0

    return {
        "files": [
            {
                **_file_to_dict(f),
                **({"is_starred": f.id in starred_ids} if project else {}),
                **({"project_name": project.name, "project_slug": project.slug} if project else {}),
            }
            for f in files
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@app.get("/api/v1/search/suggest")
async def suggest(
    q: str = Query(..., min_length=1),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if es_client:
        try:
            body = {
                "query": {
                    "bool": {
                        "must": [
                            {"match": {"original_name": {"query": q, "analyzer": "search_analyzer"}}}
                        ],
                        "filter": [
                            {"term": {"user_id": user.id}},
                            {"term": {"is_deleted": False}},
                        ],
                    }
                },
                "size": 8,
                "_source": ["original_name", "mime_type"],
            }
            es_result = await es_client.search(index="cloudvault-files", body=body)
            suggestions = [
                {"name": hit["_source"]["original_name"], "id": hit["_id"]}
                for hit in es_result["hits"]["hits"]
            ]
            return {"suggestions": suggestions}
        except Exception:
            pass

    # Fallback
    result = await db.execute(
        select(File.id, File.original_name)
        .where(
            File.user_id == user.id,
            File.is_deleted == False,
            File.original_name.like(f"%{q}%"),
        )
        .limit(8)
    )
    rows = result.all()
    return {"suggestions": [{"id": r[0], "name": r[1]} for r in rows]}


# ══════════════════════════════════════════════
# ACTIVITY (AUDIT LOG) ROUTES
# ══════════════════════════════════════════════

@app.get("/api/v1/activity")
async def get_activity(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    project_id: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if project_id:
        project_result = await db.execute(
            select(Project).where((Project.id == project_id) | (Project.slug == project_id))
        )
        project = project_result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        if user.role != "admin":
            membership = await db.scalar(
                select(ProjectMembership.id).where(
                    ProjectMembership.project_id == project.id,
                    ProjectMembership.user_id == user.id,
                )
            )
            if not membership:
                raise HTTPException(status_code=403, detail="Project access denied")
        activity_filter = AuditLog.project_id == project.id
    else:
        activity_filter = AuditLog.user_id == user.id

    query = (
        select(AuditLog)
        .where(activity_filter)
        .order_by(AuditLog.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    logs = result.scalars().all()

    count_q = select(func.count()).select_from(
        select(AuditLog).where(activity_filter).subquery()
    )
    total = (await db.execute(count_q)).scalar() or 0

    return {
        "activities": [
            {
                "id": log.id,
                "action": log.action,
                "resource_type": log.resource_type,
                "resource_id": log.resource_id,
                "user_id": log.user_id,
                "project_id": log.project_id,
                "service_account_id": log.service_account_id,
                "details": log.details_json,
                "created_at": log.created_at.isoformat() if log.created_at else None,
            }
            for log in logs
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


# ══════════════════════════════════════════════
# SHARING ROUTES
# ══════════════════════════════════════════════

@app.post("/api/v1/share/", status_code=201)
async def create_share_link(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    file_id = body.get("file_id")
    if not file_id:
        raise HTTPException(status_code=400, detail="file_id is required")

    # Verify file ownership
    f_result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id)
    )
    f = f_result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    token = secrets.token_urlsafe(32)
    password_hash = None
    if body.get("password"):
        password_hash = bcrypt.hashpw(
            body["password"].encode("utf-8"), bcrypt.gensalt()
        ).decode("utf-8")

    expires_at = None
    if body.get("expires_in_days"):
        expires_at = datetime.now(timezone.utc) + timedelta(days=int(body["expires_in_days"]))

    link = SharedLink(
        file_id=file_id,
        user_id=user.id,
        token=token,
        password_hash=password_hash,
        expires_at=expires_at,
        max_downloads=body.get("max_downloads"),
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)

    return {
        "id": link.id,
        "file_id": link.file_id,
        "token": link.token,
        "has_password": password_hash is not None,
        "expires_at": link.expires_at.isoformat() if link.expires_at else None,
        "max_downloads": link.max_downloads,
        "download_count": link.download_count,
        "created_at": link.created_at.isoformat() if link.created_at else None,
    }


@app.get("/api/v1/share/access/{token}")
async def access_share_public(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SharedLink).where(SharedLink.token == token, SharedLink.is_active == True)
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found or revoked")

    # Check expiry
    if link.expires_at and link.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Share link has expired")

    # Check download limit
    if link.max_downloads and link.download_count >= link.max_downloads:
        raise HTTPException(status_code=410, detail="Download limit reached")

    # Require password if set
    if link.password_hash:
        return {"requires_password": True, "file_id": link.file_id}

    # Get file info
    f_result = await db.execute(select(File).where(File.id == link.file_id))
    f = f_result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File no longer exists")

    # Increment download count
    link.download_count += 1
    await db.commit()

    # Generate presigned URL
    from datetime import timedelta
    try:
        response_headers = {"response-content-disposition": f'attachment; filename="{f.original_name}"'}
        if f.mime_type and f.mime_type.startswith("text/") and "charset" not in f.mime_type:
            response_headers["response-content-type"] = f"{f.mime_type}; charset=utf-8"
            
        download_url = minio_public_client.presigned_get_object(
            f.minio_bucket,
            f.minio_key,
            expires=timedelta(hours=1),
            response_headers=response_headers,
        )
    except Exception as e:
        print(f"Error generating presigned URL: {e}")
        download_url = None

    return {
        "requires_password": False,
        "file": _file_to_dict(f),
        "download_url": download_url,
    }


@app.post("/api/v1/share/access/{token}")
async def access_share_with_password(
    token: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SharedLink).where(SharedLink.token == token, SharedLink.is_active == True)
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Share link not found or revoked")

    if link.expires_at and link.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Share link has expired")

    if link.max_downloads and link.download_count >= link.max_downloads:
        raise HTTPException(status_code=410, detail="Download limit reached")

    password = body.get("password", "")
    if not link.password_hash or not bcrypt.checkpw(
        password.encode("utf-8"), link.password_hash.encode("utf-8")
    ):
        raise HTTPException(status_code=403, detail="Incorrect password")

    f_result = await db.execute(select(File).where(File.id == link.file_id))
    f = f_result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File no longer exists")

    link.download_count += 1
    await db.commit()

    # Generate presigned URL
    from datetime import timedelta
    try:
        response_headers = {"response-content-disposition": f'attachment; filename="{f.original_name}"'}
        if f.mime_type and f.mime_type.startswith("text/") and "charset" not in f.mime_type:
            response_headers["response-content-type"] = f"{f.mime_type}; charset=utf-8"
            
        download_url = minio_public_client.presigned_get_object(
            f.minio_bucket,
            f.minio_key,
            expires=timedelta(hours=1),
            response_headers=response_headers,
        )
    except Exception as e:
        print(f"Error generating presigned URL: {e}")
        download_url = None

    return {
        "file": _file_to_dict(f),
        "download_url": download_url,
    }


@app.get("/api/v1/share/links/mine")
async def list_my_links(
    page: int = Query(1, ge=1),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(SharedLink)
        .where(SharedLink.user_id == user.id)
        .order_by(SharedLink.created_at.desc())
        .offset((page - 1) * 20)
        .limit(20)
    )
    result = await db.execute(query)
    links = result.scalars().all()

    return {
        "links": [
            {
                "id": l.id,
                "file_id": l.file_id,
                "token": l.token,
                "has_password": l.password_hash is not None,
                "expires_at": l.expires_at.isoformat() if l.expires_at else None,
                "max_downloads": l.max_downloads,
                "download_count": l.download_count,
                "is_active": l.is_active,
                "created_at": l.created_at.isoformat() if l.created_at else None,
            }
            for l in links
        ]
    }


@app.get("/api/v1/share/links/file/{file_id}")
async def list_file_links(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SharedLink)
        .where(SharedLink.file_id == file_id, SharedLink.user_id == user.id)
        .order_by(SharedLink.created_at.desc())
    )
    links = result.scalars().all()

    return {
        "links": [
            {
                "id": l.id,
                "file_id": l.file_id,
                "token": l.token,
                "has_password": l.password_hash is not None,
                "expires_at": l.expires_at.isoformat() if l.expires_at else None,
                "max_downloads": l.max_downloads,
                "download_count": l.download_count,
                "is_active": l.is_active,
                "created_at": l.created_at.isoformat() if l.created_at else None,
            }
            for l in links
        ]
    }


@app.delete("/api/v1/share/links/{link_id}", status_code=204)
async def revoke_link(
    link_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SharedLink).where(SharedLink.id == link_id, SharedLink.user_id == user.id)
    )
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")

    link.is_active = False
    await db.commit()

@app.get("/api/v1/metadata/admin/stats")
async def get_metadata_admin_stats(
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    # Total files and folders
    total_files = await db.scalar(select(func.count(File.id))) or 0
    total_folders = await db.scalar(select(func.count(Folder.id))) or 0
    
    # Files by mime type
    mime_res = await db.execute(select(File.mime_type, func.count(File.id)).group_by(File.mime_type))
    mime_types = [{"name": row[0] or "unknown", "count": row[1]} for row in mime_res.all()]
    
    # Uploads by date (last 30 days)
    # Using python datetime for filtering if needed, but here we just get all grouped by date
    from datetime import datetime, timedelta
    thirty_days_ago = datetime.utcnow() - timedelta(days=30)
    
    date_query = select(
        func.date(File.created_at).label("date"),
        func.count(File.id).label("count"),
        func.sum(File.size).label("size")
    ).where(File.created_at >= thirty_days_ago).group_by(func.date(File.created_at)).order_by(func.date(File.created_at))
    
    date_res = await db.execute(date_query)
    upload_timeline = []
    for row in date_res.all():
        upload_timeline.append({
            "date": str(row[0]),
            "count": row[1],
            "size": int(row[2] or 0)
        })
        
    return {
        "total_files": total_files,
        "total_folders": total_folders,
        "files_by_type": mime_types,
        "upload_timeline": upload_timeline
    }
