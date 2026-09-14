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
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

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
from app.dependencies import get_current_user
from app.models import User, File, Folder, FileVersion, SharedLink, AuditLog, AnalyticsDaily

# ── Elasticsearch & Redis clients ──
es_client: AsyncElasticsearch | None = None
redis_client: aioredis.Redis | None = None
minio_public_client = Minio(
    settings.MINIO_ENDPOINT,
    access_key=settings.MINIO_ROOT_USER,
    secret_key=settings.MINIO_ROOT_PASSWORD,
    secure=False,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global es_client, redis_client
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    es_client = AsyncElasticsearch(settings.ELASTICSEARCH_URL)
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
                            "folder_id": {"type": "keyword"},
                            "size": {"type": "long"},
                            "is_deleted": {"type": "boolean"},
                            "created_at": {"type": "date"},
                            "updated_at": {"type": "date"},
                        }
                    },
                },
            )
    except Exception:
        pass  # ES may not be ready yet; search-indexer will handle it

    yield
    if es_client:
        await es_client.close()
    if redis_client:
        await redis_client.close()


# ── FastAPI App ──

app = FastAPI(
    title="CloudVault Metadata Service",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
async def websocket_notifications(websocket: WebSocket, token: str = Query(None)):
    if not token:
        await websocket.close(code=1008)
        return
    try:
        user = await get_current_user(token)
    except Exception:
        await websocket.close(code=1008)
        return
        
    await websocket.accept()
    
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

    if folder_id is not None:
        query = query.where(File.folder_id == folder_id)
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
        if folder_id:
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
    # Recalculate storage used
    result = await db.execute(
        select(func.coalesce(func.sum(File.size), 0)).where(
            File.user_id == user.id, File.is_deleted == False
        )
    )
    used = result.scalar() or 0
    return {
        "storage_used": used,
        "storage_quota": user.storage_quota,
        "percentage": round((used / user.storage_quota * 100), 2) if user.storage_quota > 0 else 0,
    }


# ══════════════════════════════════════════════
# SEARCH ROUTES
# ══════════════════════════════════════════════

@app.get("/api/v1/search/")
async def search_files(
    q: str = Query(..., min_length=1),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Try Elasticsearch first
    if es_client:
        try:
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
                        "filter": [
                            {"term": {"user_id": user.id}},
                            {"term": {"is_deleted": False}},
                        ],
                    }
                },
                "from": (page - 1) * page_size,
                "size": page_size,
                "highlight": {
                    "fields": {"original_name": {}, "filename": {}, "content": {}}
                },
            }
            es_result = await es_client.search(index="cloudvault-files", body=body)
            hits = es_result["hits"]
            total = hits["total"]["value"] if isinstance(hits["total"], dict) else hits["total"]

            files = []
            for hit in hits["hits"]:
                src = hit["_source"]
                src["id"] = hit["_id"]
                if "highlight" in hit:
                    src["highlight"] = hit["highlight"]
                files.append(src)

            return {"files": files, "total": total, "page": page, "page_size": page_size}
        except Exception:
            pass  # Fallback to MySQL LIKE search

    # Fallback: MySQL search
    query = (
        select(File)
        .where(
            File.user_id == user.id,
            File.is_deleted == False,
            File.original_name.like(f"%{q}%"),
        )
        .order_by(File.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    files = result.scalars().all()

    count_q = select(func.count()).select_from(
        select(File).where(
            File.user_id == user.id,
            File.is_deleted == False,
            File.original_name.like(f"%{q}%"),
        ).subquery()
    )
    total = (await db.execute(count_q)).scalar() or 0

    return {
        "files": [_file_to_dict(f) for f in files],
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
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(AuditLog)
        .where(AuditLog.user_id == user.id)
        .order_by(AuditLog.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    result = await db.execute(query)
    logs = result.scalars().all()

    count_q = select(func.count()).select_from(
        select(AuditLog).where(AuditLog.user_id == user.id).subquery()
    )
    total = (await db.execute(count_q)).scalar() or 0

    return {
        "activities": [
            {
                "id": log.id,
                "action": log.action,
                "resource_type": log.resource_type,
                "resource_id": log.resource_id,
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
