"""
CloudVault — File Service Main Application

Endpoints matching the frontend api.ts contract:
  POST   /api/v1/files/upload             — upload a file
  GET    /api/v1/files/:id/download       — get presigned download URL
  DELETE /api/v1/files/:id                — soft-delete (move to trash)
  GET    /api/v1/files/trash/list         — list trashed files
  DELETE /api/v1/files/:id/permanent      — permanent delete
  POST   /api/v1/files/:id/restore        — restore from trash
  POST   /api/v1/files/:id/copy           — copy a file
  POST   /api/v1/files/:id/move           — move a file to another folder
  POST   /api/v1/folders                  — create a folder
  GET    /api/v1/folders                  — list folders
"""

import asyncio
import hashlib
import json
import os
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt as pyjwt
import redis.asyncio as aioredis
from aiokafka import AIOKafkaProducer
from fastapi import FastAPI, Depends, HTTPException, Header, Query, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from minio import Minio
from pydantic import BaseModel, Field
from prometheus_fastapi_instrumentator import Instrumentator
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db, async_session
from app.models import (
    User, File, Folder, FileVersion, Project, ProjectMembership,
    ProjectFileStar, ServiceAccount, ProjectUpload,
)

# ── Global clients ──
minio_client: Minio | None = None
minio_public_client: Minio | None = None
kafka_producer: AIOKafkaProducer | None = None
redis_client: aioredis.Redis | None = None
reconciliation_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global minio_client, minio_public_client, kafka_producer, redis_client, reconciliation_task

    # MinIO
    minio_client = Minio(
        settings.MINIO_ENDPOINT,
        access_key=settings.MINIO_ROOT_USER,
        secret_key=settings.MINIO_ROOT_PASSWORD,
        secure=False,
    )

    # MinIO Client for presigned URLs (uses public endpoint)
    minio_public_client = Minio(
        settings.MINIO_PUBLIC_ENDPOINT,
        access_key=settings.MINIO_ROOT_USER,
        secret_key=settings.MINIO_ROOT_PASSWORD,
        secure=False,
        region="us-east-1",
    )

    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)

    # Kafka
    try:
        kafka_producer = AIOKafkaProducer(
            bootstrap_servers=settings.KAFKA_BOOTSTRAP_SERVERS,
            value_serializer=lambda v: json.dumps(v, default=str).encode("utf-8"),
        )
        await kafka_producer.start()
    except Exception:
        kafka_producer = None

    reconciliation_task = asyncio.create_task(_project_upload_reconciliation_loop())

    yield

    if kafka_producer:
        await kafka_producer.stop()
    if redis_client:
        await redis_client.aclose()
    if reconciliation_task:
        reconciliation_task.cancel()
        with suppress(asyncio.CancelledError):
            await reconciliation_task


# ── FastAPI App ──

app = FastAPI(
    title="CloudVault File Service",
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
setup_opentelemetry(app, "file-service")


# ── Dependencies ──

async def get_current_user(
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")

    token = authorization.split(" ", 1)[1]
    try:
        payload = pyjwt.decode(
            token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")

    jti = payload.get("jti")
    if jti and redis_client and await redis_client.get(f"blacklist:{jti}"):
        raise HTTPException(status_code=401, detail="Token has been revoked")

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


async def _emit_event(event_type: str, data: dict):
    if kafka_producer:
        try:
            await kafka_producer.send_and_wait(
                settings.KAFKA_TOPIC_FILE_EVENTS,
                {"event": event_type, **data},
            )
        except Exception:
            pass  # Non-critical


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
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


def _project_file_to_dict(f: File, *, is_starred: bool = False) -> dict:
    return {
        "id": f.id,
        # Stable integration contract for machine clients. Keep ``id`` for
        # backwards compatibility with the existing web application.
        "file_id": f.id,
        "project_id": f.project_id,
        "original_name": f.original_name,
        "mime_type": f.mime_type,
        "size": f.size,
        "checksum_sha256": f.checksum_sha256,
        "status": f.status,
        "is_deleted": f.is_deleted,
        "deleted_at": f.deleted_at.isoformat() if f.deleted_at else None,
        "is_starred": is_starred,
        "metadata": f.metadata_json or {},
        "retention_until": f.retention_until.isoformat() if f.retention_until else None,
        "created_at": f.created_at.isoformat() if f.created_at else None,
        "updated_at": f.updated_at.isoformat() if f.updated_at else None,
    }


def _api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


async def _project_starred_ids(
    db: AsyncSession,
    user_id: str | None,
    file_ids: list[str],
) -> set[str]:
    if not user_id or not file_ids:
        return set()
    result = await db.execute(
        select(ProjectFileStar.file_id).where(
            ProjectFileStar.user_id == user_id,
            ProjectFileStar.file_id.in_(file_ids),
        )
    )
    return set(result.scalars().all())


@dataclass
class ProjectPrincipal:
    project: Project
    user: User | None = None
    service_account: ServiceAccount | None = None
    member_role: str | None = None


class ProjectBulkFilesRequest(BaseModel):
    file_ids: list[str] = Field(..., min_length=1, max_length=500)


class ProjectBulkStarRequest(ProjectBulkFilesRequest):
    starred: bool


async def _resolve_project_principal(
    project_id: str,
    authorization: str | None,
    db: AsyncSession,
    *,
    service_scope: str,
    user_roles: set[str],
) -> ProjectPrincipal:
    if not authorization or not authorization.startswith("Bearer "):
        raise _api_error(401, "INVALID_CREDENTIAL", "Missing or invalid credential")

    token = authorization.split(" ", 1)[1]
    project_result = await db.execute(
        select(Project).where((Project.id == project_id) | (Project.slug == project_id))
    )
    project = project_result.scalar_one_or_none()
    if not project:
        raise _api_error(404, "PROJECT_NOT_FOUND", "Project not found")

    if token.startswith("cvp_"):
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        account_result = await db.execute(
            select(ServiceAccount).where(ServiceAccount.token_hash == token_hash)
        )
        account = account_result.scalar_one_or_none()
        now = datetime.now(timezone.utc)
        expires_at = account.expires_at if account else None
        if expires_at and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if (
            not account
            or not account.is_active
            or account.revoked_at is not None
            or account.project_id != project.id
            or (expires_at is not None and expires_at <= now)
        ):
            raise _api_error(401, "INVALID_CREDENTIAL", "Service credential is invalid or expired")
        if service_scope not in (account.scopes or []):
            raise _api_error(403, "PROJECT_ACCESS_DENIED", "Service account scope is insufficient")
        account.last_used_at = now
        await db.flush()
        return ProjectPrincipal(project=project, service_account=account)

    try:
        payload = pyjwt.decode(
            token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM]
        )
    except Exception:
        raise _api_error(401, "INVALID_CREDENTIAL", "User credential is invalid or expired")
    if payload.get("type") != "access":
        raise _api_error(401, "INVALID_CREDENTIAL", "Invalid token type")
    jti = payload.get("jti")
    if jti and redis_client and await redis_client.get(f"blacklist:{jti}"):
        raise _api_error(401, "INVALID_CREDENTIAL", "Token has been revoked")

    user_result = await db.execute(select(User).where(User.id == payload.get("sub")))
    user = user_result.scalar_one_or_none()
    if not user or not user.is_active:
        raise _api_error(401, "INVALID_CREDENTIAL", "User not found or inactive")
    if user.role == "admin":
        return ProjectPrincipal(project=project, user=user, member_role="admin")

    membership_result = await db.execute(
        select(ProjectMembership).where(
            ProjectMembership.project_id == project.id,
            ProjectMembership.user_id == user.id,
        )
    )
    membership = membership_result.scalar_one_or_none()
    if not membership or membership.role not in user_roles:
        raise _api_error(403, "PROJECT_ACCESS_DENIED", "Project role is insufficient")
    return ProjectPrincipal(project=project, user=user, member_role=membership.role)


def _project_retention_until(project: Project, metadata: dict) -> datetime | None:
    policy = project.retention_policy or {}
    retention_class = metadata.get("retention_class")
    days = policy.get(f"{retention_class}_days") or policy.get("default_days")
    if isinstance(days, int) and days > 0:
        return datetime.now(timezone.utc) + timedelta(days=days)
    return None


async def _release_project_reservation(
    db: AsyncSession,
    project_id: str,
    upload_id: str,
    error_code: str,
) -> None:
    await db.rollback()
    project_result = await db.execute(
        select(Project).where(Project.id == project_id).with_for_update()
    )
    project = project_result.scalar_one()
    upload_result = await db.execute(
        select(ProjectUpload).where(ProjectUpload.id == upload_id).with_for_update()
    )
    upload = upload_result.scalar_one_or_none()
    if upload and upload.status == "PENDING":
        project.storage_used = max(0, project.storage_used - upload.reserved_bytes)
        upload.reserved_bytes = 0
        upload.status = "FAILED"
        upload.error_code = error_code
        await db.commit()


async def _reconcile_stale_project_uploads() -> None:
    stale_before = datetime.now(timezone.utc) - timedelta(minutes=30)
    async with async_session() as db:
        result = await db.execute(
            select(ProjectUpload).where(
                ProjectUpload.status.in_(["PENDING", "FAILED"]),
                ProjectUpload.updated_at < stale_before,
            ).limit(100)
        )
        upload_ids = [item.id for item in result.scalars().all()]
        await db.rollback()

        for upload_id in upload_ids:
            upload_result = await db.execute(
                select(ProjectUpload).where(ProjectUpload.id == upload_id).with_for_update()
            )
            upload = upload_result.scalar_one_or_none()
            if not upload or upload.status not in {"PENDING", "FAILED"}:
                await db.rollback()
                continue
            if upload.status == "PENDING" and upload.reserved_bytes:
                project_result = await db.execute(
                    select(Project).where(Project.id == upload.project_id).with_for_update()
                )
                project = project_result.scalar_one()
                project.storage_used = max(0, project.storage_used - upload.reserved_bytes)
                upload.reserved_bytes = 0
            object_key = upload.object_key
            upload.object_key = None
            upload.status = "FAILED"
            upload.error_code = upload.error_code or "STALE_UPLOAD"
            await db.commit()
            if object_key:
                try:
                    await asyncio.to_thread(
                        minio_client.remove_object, settings.MINIO_BUCKET_FILES, object_key
                    )
                except Exception:
                    pass


async def _project_upload_reconciliation_loop() -> None:
    while True:
        try:
            await _reconcile_stale_project_uploads()
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
        await asyncio.sleep(300)


def _stream_minio_object(response):
    try:
        while chunk := response.read(1024 * 1024):
            yield chunk
    finally:
        response.close()
        response.release_conn()


# ── Health Check ──

@app.get("/health")
async def health():
    return {"status": "ok", "service": "file"}


# ══════════════════════════════════════════════
# PROJECT FILES
# ══════════════════════════════════════════════

@app.get("/api/v1/projects/{project_id}/usage")
async def get_project_usage(
    project_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="project:usage:read",
        user_roles={"viewer", "editor", "admin"},
    )
    project = principal.project
    available = max(0, project.storage_quota - project.storage_used)
    percentage = round((project.storage_used / project.storage_quota * 100), 2) if project.storage_quota else 0
    await db.commit()
    return {
        "project_id": project.id,
        "storage_used": project.storage_used,
        "storage_quota": project.storage_quota,
        "available_bytes": available,
        "percentage": percentage,
        "warning_percent": project.warning_percent,
    }


@app.get("/api/v1/projects/{project_id}/files")
async def list_project_files(
    project_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None, max_length=255),
    artifact_type: str | None = Query(None, max_length=120),
    starred: bool | None = Query(None),
    sort_by: str = Query("created_at"),
    sort_order: str = Query("desc"),
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:read",
        user_roles={"viewer", "editor", "admin"},
    )
    query = select(File).where(
        File.project_id == principal.project.id,
        File.status == "AVAILABLE",
        File.is_deleted == False,
    )
    if q:
        query = query.where(File.original_name.ilike(f"%{q.strip()}%"))
    artifact_expression = func.JSON_UNQUOTE(func.JSON_EXTRACT(File.metadata_json, "$.artifact_type"))
    if artifact_type:
        query = query.where(artifact_expression == artifact_type.strip())
    if starred is not None:
        if not principal.user:
            raise _api_error(400, "INVALID_FILTER", "Star filtering is available to users only")
        if starred:
            query = query.join(
                ProjectFileStar,
                (ProjectFileStar.file_id == File.id)
                & (ProjectFileStar.user_id == principal.user.id),
            )
        else:
            query = query.outerjoin(
                ProjectFileStar,
                (ProjectFileStar.file_id == File.id)
                & (ProjectFileStar.user_id == principal.user.id),
            ).where(ProjectFileStar.file_id.is_(None))

    sort_columns = {
        "created_at": File.created_at,
        "updated_at": File.updated_at,
        "name": File.original_name,
        "size": File.size,
        "artifact_type": artifact_expression,
    }
    if sort_by not in sort_columns or sort_order not in {"asc", "desc"}:
        raise _api_error(400, "INVALID_FILTER", "Invalid project file sort")
    total = await db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
    sort_column = sort_columns[sort_by]
    query = query.order_by(sort_column.asc() if sort_order == "asc" else sort_column.desc())
    result = await db.execute(query.limit(limit).offset(offset))
    files = result.scalars().all()
    starred_ids = await _project_starred_ids(
        db,
        principal.user.id if principal.user else None,
        [item.id for item in files],
    )
    await db.commit()
    return {
        "files": [
            _project_file_to_dict(item, is_starred=item.id in starred_ids)
            for item in files
        ],
        "limit": limit,
        "offset": offset,
        "total": total,
    }


@app.post("/api/v1/projects/{project_id}/files/upload", status_code=201)
async def upload_project_file(
    project_id: str,
    file: UploadFile,
    metadata_json: str = Form(...),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:create",
        user_roles={"editor", "admin"},
    )
    project = principal.project
    if project.status != "active":
        raise _api_error(403, "PROJECT_ACCESS_DENIED", "Project is not active")
    if not idempotency_key or len(idempotency_key) > 255:
        raise _api_error(400, "INVALID_FILE", "Idempotency-Key is required and must be at most 255 characters")
    if len(metadata_json.encode("utf-8")) > 16384:
        raise _api_error(400, "INVALID_FILE", "metadata_json exceeds 16 KiB")

    try:
        metadata = json.loads(metadata_json)
    except (TypeError, json.JSONDecodeError):
        raise _api_error(400, "INVALID_FILE", "metadata_json must be a JSON object")
    required_metadata = {"artifact_type", "logical_date", "source_run_id", "retention_class"}
    if not isinstance(metadata, dict) or not required_metadata.issubset(metadata):
        raise _api_error(400, "INVALID_FILE", "Required metadata fields are missing")

    allowed_mime_types = (project.retention_policy or {}).get("allowed_mime_types")
    content_type = file.content_type or "application/octet-stream"
    if isinstance(allowed_mime_types, list) and allowed_mime_types and content_type not in allowed_mime_types:
        raise _api_error(400, "INVALID_FILE", "File MIME type is not allowed by project policy")

    hasher = hashlib.sha256()
    file_size = 0
    while chunk := await file.read(1024 * 1024):
        hasher.update(chunk)
        file_size += len(chunk)
        if file_size > project.max_file_size:
            raise _api_error(413, "FILE_TOO_LARGE", "File exceeds the project file-size limit")
    await file.seek(0)
    if file_size == 0:
        raise _api_error(400, "INVALID_FILE", "Empty files are not accepted")
    checksum = hasher.hexdigest()
    supplied_checksum = metadata.get("checksum_sha256")
    if supplied_checksum and supplied_checksum != checksum:
        raise _api_error(400, "INVALID_FILE", "Supplied checksum does not match file content")
    metadata["checksum_sha256"] = checksum

    existing_result = await db.execute(
        select(ProjectUpload).where(
            ProjectUpload.project_id == project.id,
            ProjectUpload.idempotency_key == idempotency_key,
        )
    )
    upload = existing_result.scalar_one_or_none()
    if upload:
        if upload.checksum_sha256 != checksum:
            raise _api_error(409, "IDEMPOTENCY_CONFLICT", "Idempotency key already exists for different content")
        if upload.status == "AVAILABLE" and upload.file_id:
            stored = await db.get(File, upload.file_id)
            if stored and stored.status == "AVAILABLE" and not stored.is_deleted:
                response = _project_file_to_dict(stored)
                response["idempotent_replay"] = True
                await db.commit()
                return response
            raise _api_error(409, "IDEMPOTENCY_CONFLICT", "Idempotent upload result is no longer available")
        if upload.status == "PENDING":
            raise _api_error(409, "UPLOAD_IN_PROGRESS", "An upload with this idempotency key is in progress")

    locked_result = await db.execute(
        select(Project)
        .where(Project.id == project.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    locked_project = locked_result.scalar_one()
    if upload and upload.status == "FAILED" and upload.reserved_bytes:
        locked_project.storage_used = max(0, locked_project.storage_used - upload.reserved_bytes)
        upload.reserved_bytes = 0
    if locked_project.storage_used + file_size > locked_project.storage_quota:
        await _emit_event("QUOTA_EXCEEDED", {
            "project_id": locked_project.id,
            "user_id": principal.user.id if principal.user else None,
            "service_account_id": principal.service_account.id if principal.service_account else None,
            "attempted_bytes": file_size,
            "storage_used": locked_project.storage_used,
            "storage_quota": locked_project.storage_quota,
        })
        raise _api_error(413, "STORAGE_QUOTA_EXCEEDED", "Project storage quota exceeded")

    stale_object_key = upload.object_key if upload and upload.status == "FAILED" else None
    if upload:
        upload.status = "PENDING"
        upload.error_code = None
        upload.reserved_bytes = file_size
        upload.object_key = None
        upload.user_id = principal.user.id if principal.user else None
        upload.service_account_id = principal.service_account.id if principal.service_account else None
    else:
        upload = ProjectUpload(
            project_id=locked_project.id,
            service_account_id=principal.service_account.id if principal.service_account else None,
            user_id=principal.user.id if principal.user else None,
            idempotency_key=idempotency_key,
            checksum_sha256=checksum,
            reserved_bytes=file_size,
            status="PENDING",
        )
        db.add(upload)
    locked_project.storage_used += file_size
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise _api_error(409, "UPLOAD_IN_PROGRESS", "Idempotency key was claimed by another request")
    await db.refresh(upload)
    if stale_object_key:
        try:
            await asyncio.to_thread(
                minio_client.remove_object, settings.MINIO_BUCKET_FILES, stale_object_key
            )
        except Exception:
            pass

    file_id = str(uuid.uuid4())
    original_name = os.path.basename(file.filename or "unnamed") or "unnamed"
    if len(original_name) > 255:
        await _release_project_reservation(db, locked_project.id, upload.id, "INVALID_FILE")
        raise _api_error(400, "INVALID_FILE", "Filename exceeds 255 characters")
    ext = original_name.rsplit(".", 1)[-1] if "." in original_name else ""
    minio_key = f"projects/{locked_project.slug}/{file_id}{f'.{ext}' if ext else ''}"
    upload.object_key = minio_key
    try:
        await db.commit()
    except Exception:
        await _release_project_reservation(db, locked_project.id, upload.id, "METADATA_WRITE_FAILED")
        raise _api_error(503, "STORAGE_UNAVAILABLE", "Upload reservation could not be persisted")
    try:
        await asyncio.to_thread(
            minio_client.put_object,
            settings.MINIO_BUCKET_FILES,
            minio_key,
            file.file,
            file_size,
            content_type=content_type,
        )
    except Exception:
        await _release_project_reservation(db, locked_project.id, upload.id, "STORAGE_UNAVAILABLE")
        raise _api_error(503, "STORAGE_UNAVAILABLE", "Object storage is temporarily unavailable")

    db_file = File(
        id=file_id,
        filename=f"{file_id}{f'.{ext}' if ext else ''}",
        original_name=original_name,
        mime_type=content_type,
        size=file_size,
        user_id=principal.user.id if principal.user else None,
        project_id=locked_project.id,
        created_by_service_account_id=principal.service_account.id if principal.service_account else None,
        minio_bucket=settings.MINIO_BUCKET_FILES,
        minio_key=minio_key,
        checksum_sha256=checksum,
        status="AVAILABLE",
        metadata_json=metadata,
        retention_until=_project_retention_until(locked_project, metadata),
    )
    db.add(db_file)
    db.add(FileVersion(
        file_id=file_id,
        version_number=1,
        minio_key=minio_key,
        size=file_size,
        checksum_sha256=checksum,
        uploaded_by=principal.user.id if principal.user else None,
        uploaded_by_service_account_id=principal.service_account.id if principal.service_account else None,
    ))
    upload.file_id = file_id
    upload.status = "AVAILABLE"
    upload.reserved_bytes = 0
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        try:
            await asyncio.to_thread(minio_client.remove_object, settings.MINIO_BUCKET_FILES, minio_key)
        except Exception:
            pass
        await _release_project_reservation(db, locked_project.id, upload.id, "METADATA_WRITE_FAILED")
        raise _api_error(503, "STORAGE_UNAVAILABLE", "File metadata could not be committed")
    try:
        await db.refresh(db_file)
    except Exception:
        pass

    await _emit_event("FILE_UPLOADED", {
        "file_id": db_file.id,
        "user_id": principal.user.id if principal.user else None,
        "project_id": locked_project.id,
        "service_account_id": principal.service_account.id if principal.service_account else None,
        "filename": db_file.original_name,
        "mime_type": db_file.mime_type,
        "size": file_size,
        "minio_key": minio_key,
    })
    return _project_file_to_dict(db_file)


@app.get("/api/v1/projects/{project_id}/files/trash")
async def list_project_trash(
    project_id: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:read",
        user_roles={"viewer", "editor", "admin"},
    )
    result = await db.execute(
        select(File)
        .where(
            File.project_id == principal.project.id,
            File.status == "DELETED",
            File.is_deleted == True,
        )
        .order_by(File.deleted_at.desc())
        .limit(limit)
        .offset(offset)
    )
    files = result.scalars().all()
    starred_ids = await _project_starred_ids(
        db,
        principal.user.id if principal.user else None,
        [item.id for item in files],
    )
    await db.commit()
    return {
        "files": [
            _project_file_to_dict(item, is_starred=item.id in starred_ids)
            for item in files
        ],
        "limit": limit,
        "offset": offset,
    }


@app.post("/api/v1/projects/{project_id}/files/{file_id}/star")
async def star_project_file(
    project_id: str,
    file_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:read",
        user_roles={"viewer", "editor", "admin"},
    )
    if not principal.user:
        raise _api_error(403, "PROJECT_ACCESS_DENIED", "File stars are available to users only")
    file_result = await db.execute(
        select(File).where(
            File.id == file_id,
            File.project_id == principal.project.id,
            File.status == "AVAILABLE",
            File.is_deleted == False,
        )
    )
    stored = file_result.scalar_one_or_none()
    if not stored:
        raise _api_error(404, "FILE_NOT_FOUND", "Project file not found")
    existing = await db.get(ProjectFileStar, (principal.user.id, stored.id))
    if not existing:
        db.add(ProjectFileStar(user_id=principal.user.id, file_id=stored.id))
        await db.commit()
    return {"file_id": stored.id, "is_starred": True}


@app.delete("/api/v1/projects/{project_id}/files/{file_id}/star")
async def unstar_project_file(
    project_id: str,
    file_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:read",
        user_roles={"viewer", "editor", "admin"},
    )
    if not principal.user:
        raise _api_error(403, "PROJECT_ACCESS_DENIED", "File stars are available to users only")
    file_result = await db.execute(
        select(File.id).where(
            File.id == file_id,
            File.project_id == principal.project.id,
        )
    )
    if not file_result.scalar_one_or_none():
        raise _api_error(404, "FILE_NOT_FOUND", "Project file not found")
    existing = await db.get(ProjectFileStar, (principal.user.id, file_id))
    if existing:
        await db.delete(existing)
        await db.commit()
    return {"file_id": file_id, "is_starred": False}


@app.post("/api/v1/projects/{project_id}/files/bulk-star")
async def bulk_star_project_files(
    project_id: str,
    req: ProjectBulkStarRequest,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:read",
        user_roles={"viewer", "editor", "admin"},
    )
    if not principal.user:
        raise _api_error(403, "PROJECT_ACCESS_DENIED", "File stars are available to users only")
    file_ids = list(dict.fromkeys(req.file_ids))
    files_result = await db.execute(
        select(File.id).where(
            File.id.in_(file_ids),
            File.project_id == principal.project.id,
            File.status == "AVAILABLE",
            File.is_deleted == False,
        )
    )
    matched_ids = set(files_result.scalars().all())
    if matched_ids != set(file_ids):
        raise _api_error(404, "FILE_NOT_FOUND", "One or more project files were not found")

    stars_result = await db.execute(
        select(ProjectFileStar).where(
            ProjectFileStar.user_id == principal.user.id,
            ProjectFileStar.file_id.in_(file_ids),
        )
    )
    existing_stars = stars_result.scalars().all()
    if req.starred:
        existing_ids = {item.file_id for item in existing_stars}
        db.add_all([
            ProjectFileStar(user_id=principal.user.id, file_id=file_id)
            for file_id in file_ids if file_id not in existing_ids
        ])
    else:
        for item in existing_stars:
            await db.delete(item)
    await db.commit()
    return {"file_ids": file_ids, "is_starred": req.starred}


@app.post("/api/v1/projects/{project_id}/files/bulk-delete")
async def bulk_delete_project_files(
    project_id: str,
    req: ProjectBulkFilesRequest,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:delete",
        user_roles={"editor", "admin"},
    )
    if principal.project.status != "active":
        raise _api_error(403, "PROJECT_ACCESS_DENIED", "Project is not active")
    file_ids = list(dict.fromkeys(req.file_ids))
    result = await db.execute(
        select(File).where(
            File.id.in_(file_ids),
            File.project_id == principal.project.id,
            File.status == "AVAILABLE",
            File.is_deleted == False,
        )
    )
    stored_files = result.scalars().all()
    if {item.id for item in stored_files} != set(file_ids):
        raise _api_error(404, "FILE_NOT_FOUND", "One or more project files were not found")

    deleted_at = datetime.now(timezone.utc)
    for stored in stored_files:
        stored.is_deleted = True
        stored.status = "DELETED"
        stored.deleted_at = deleted_at
    await db.commit()
    for stored in stored_files:
        await _emit_event("FILE_DELETED", {
            "file_id": stored.id,
            "user_id": principal.user.id if principal.user else None,
            "project_id": principal.project.id,
            "service_account_id": principal.service_account.id if principal.service_account else None,
            "filename": stored.original_name,
        })
    return {"file_ids": file_ids, "detail": "Project files moved to trash"}


@app.get("/api/v1/projects/{project_id}/files/{file_id}")
async def get_project_file(
    project_id: str,
    file_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:read",
        user_roles={"viewer", "editor", "admin"},
    )
    result = await db.execute(
        select(File).where(
            File.id == file_id,
            File.project_id == principal.project.id,
            File.status == "AVAILABLE",
            File.is_deleted == False,
        )
    )
    stored = result.scalar_one_or_none()
    if not stored:
        raise _api_error(404, "FILE_NOT_FOUND", "Project file not found")
    starred_ids = await _project_starred_ids(
        db,
        principal.user.id if principal.user else None,
        [stored.id],
    )
    await db.commit()
    return _project_file_to_dict(stored, is_starred=stored.id in starred_ids)


@app.get("/api/v1/projects/{project_id}/files/{file_id}/download")
async def download_project_file(
    project_id: str,
    file_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:read",
        user_roles={"viewer", "editor", "admin"},
    )
    result = await db.execute(
        select(File).where(
            File.id == file_id,
            File.project_id == principal.project.id,
            File.status == "AVAILABLE",
            File.is_deleted == False,
        )
    )
    stored = result.scalar_one_or_none()
    if not stored:
        raise _api_error(404, "FILE_NOT_FOUND", "Project file not found")
    try:
        response = await asyncio.to_thread(
            minio_client.get_object, stored.minio_bucket, stored.minio_key
        )
    except Exception:
        raise _api_error(503, "STORAGE_UNAVAILABLE", "Object storage is temporarily unavailable")
    await db.commit()
    await _emit_event("FILE_DOWNLOADED", {
        "file_id": stored.id,
        "user_id": principal.user.id if principal.user else None,
        "project_id": principal.project.id,
        "service_account_id": principal.service_account.id if principal.service_account else None,
        "filename": stored.original_name,
    })
    safe_name = stored.original_name.replace('"', "").replace("\r", "").replace("\n", "")
    headers = {"Content-Disposition": f'attachment; filename="{safe_name}"'}
    return StreamingResponse(_stream_minio_object(response), media_type=stored.mime_type, headers=headers)


@app.delete("/api/v1/projects/{project_id}/files/{file_id}")
async def delete_project_file(
    project_id: str,
    file_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:delete",
        user_roles={"editor", "admin"},
    )
    if principal.project.status != "active":
        raise _api_error(403, "PROJECT_ACCESS_DENIED", "Project is not active")
    result = await db.execute(
        select(File).where(
            File.id == file_id,
            File.project_id == principal.project.id,
            File.status == "AVAILABLE",
            File.is_deleted == False,
        )
    )
    stored = result.scalar_one_or_none()
    if not stored:
        raise _api_error(404, "FILE_NOT_FOUND", "Project file not found")
    stored.is_deleted = True
    stored.status = "DELETED"
    stored.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    await _emit_event("FILE_DELETED", {
        "file_id": stored.id,
        "user_id": principal.user.id if principal.user else None,
        "project_id": principal.project.id,
        "service_account_id": principal.service_account.id if principal.service_account else None,
        "filename": stored.original_name,
    })
    return {"detail": "Project file moved to trash"}


@app.post("/api/v1/projects/{project_id}/files/{file_id}/restore")
async def restore_project_file(
    project_id: str,
    file_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:create",
        user_roles={"editor", "admin"},
    )
    if principal.project.status != "active":
        raise _api_error(409, "PROJECT_NOT_ACTIVE", "Restore the project before restoring files")
    result = await db.execute(
        select(File).where(
            File.id == file_id,
            File.project_id == principal.project.id,
            File.status == "DELETED",
            File.is_deleted == True,
        )
    )
    stored = result.scalar_one_or_none()
    if not stored:
        raise _api_error(404, "FILE_NOT_FOUND", "Project file not found in trash")

    stored.is_deleted = False
    stored.status = "AVAILABLE"
    stored.deleted_at = None
    await db.commit()
    await db.refresh(stored)
    starred_ids = await _project_starred_ids(
        db,
        principal.user.id if principal.user else None,
        [stored.id],
    )
    await _emit_event("FILE_RESTORED", {
        "file_id": stored.id,
        "user_id": principal.user.id if principal.user else None,
        "project_id": principal.project.id,
        "service_account_id": principal.service_account.id if principal.service_account else None,
        "filename": stored.original_name,
    })
    return _project_file_to_dict(stored, is_starred=stored.id in starred_ids)


@app.delete("/api/v1/projects/{project_id}/files/{file_id}/permanent")
async def permanently_delete_project_file(
    project_id: str,
    file_id: str,
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
):
    principal = await _resolve_project_principal(
        project_id, authorization, db,
        service_scope="files:delete",
        user_roles={"admin"},
    )
    result = await db.execute(
        select(File).where(
            File.id == file_id,
            File.project_id == principal.project.id,
            File.status == "DELETED",
            File.is_deleted == True,
        )
    )
    stored = result.scalar_one_or_none()
    if not stored:
        raise _api_error(404, "FILE_NOT_FOUND", "Project file not found in trash")

    versions_result = await db.execute(
        select(FileVersion).where(FileVersion.file_id == stored.id)
    )
    versions = versions_result.scalars().all()
    stored_objects = {version.minio_key: version.size for version in versions}
    stored_objects.setdefault(stored.minio_key, stored.size)

    try:
        for object_key in stored_objects:
            await asyncio.to_thread(minio_client.remove_object, stored.minio_bucket, object_key)
        if stored.thumbnail_key:
            await asyncio.to_thread(
                minio_client.remove_object,
                settings.MINIO_BUCKET_THUMBNAILS,
                stored.thumbnail_key,
            )
    except Exception:
        raise _api_error(503, "STORAGE_UNAVAILABLE", "Object storage deletion failed; retry safely")

    project_result = await db.execute(
        select(Project).where(Project.id == principal.project.id).with_for_update()
    )
    locked_project = project_result.scalar_one()
    released_bytes = sum(stored_objects.values())
    original_name = stored.original_name
    locked_project.storage_used = max(0, locked_project.storage_used - released_bytes)
    await db.delete(stored)
    await db.commit()

    await _emit_event("FILE_PERMANENTLY_DELETED", {
        "file_id": file_id,
        "user_id": principal.user.id if principal.user else None,
        "project_id": principal.project.id,
        "service_account_id": principal.service_account.id if principal.service_account else None,
        "filename": original_name,
        "released_bytes": released_bytes,
    })
    return {"detail": "Project file permanently deleted", "released_bytes": released_bytes}


# ══════════════════════════════════════════════
# FILE UPLOAD / DOWNLOAD
# ══════════════════════════════════════════════

import io

@app.get("/api/v1/files/project-starred")
async def list_starred_project_files(
    limit: int = Query(100, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(File, Project)
        .join(ProjectFileStar, ProjectFileStar.file_id == File.id)
        .join(Project, Project.id == File.project_id)
        .where(
            ProjectFileStar.user_id == user.id,
            File.status == "AVAILABLE",
            File.is_deleted == False,
        )
        .order_by(ProjectFileStar.created_at.desc())
        .limit(limit)
    )
    if user.role != "admin":
        query = query.join(
            ProjectMembership,
            (ProjectMembership.project_id == Project.id)
            & (ProjectMembership.user_id == user.id),
        )
    result = await db.execute(query)
    files = []
    for stored, project in result.all():
        item = _project_file_to_dict(stored, is_starred=True)
        item["project_name"] = project.name
        item["project_slug"] = project.slug
        files.append(item)
    return {"files": files}


@app.post("/api/v1/files/upload", status_code=201)
async def upload_file(
    file: UploadFile,
    folder_id: str = Form(None),
    relative_path: str = Form(None),
    is_encrypted: str = Form(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Determine size and checksum incrementally. UploadFile uses a spooled file,
    # so this avoids allocating another full-size bytes object in memory.
    hasher = hashlib.sha256()
    file_size = 0
    while chunk := await file.read(1024 * 1024):
        hasher.update(chunk)
        file_size += len(chunk)
    await file.seek(0)

    # Check storage quota
    if user.storage_used + file_size > user.storage_quota:
        raise HTTPException(status_code=413, detail="Storage quota exceeded")

    # Generate unique key
    file_id = str(uuid.uuid4())
    ext = file.filename.rsplit(".", 1)[-1] if "." in file.filename else ""
    minio_key = f"{user.id}/{file_id}{f'.{ext}' if ext else ''}"

    # Compute checksum
    checksum = hasher.hexdigest()

    # Upload to MinIO
    try:
        await asyncio.to_thread(
            minio_client.put_object,
            settings.MINIO_BUCKET_FILES,
            minio_key,
            file.file,
            file_size,
            content_type=file.content_type or "application/octet-stream",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload to storage failed: {str(e)}")

    # Handle folder from relative_path (e.g., drag-and-drop folder upload)
    actual_folder_id = folder_id
    if relative_path and "/" in relative_path:
        # Create intermediate folders
        parts = relative_path.split("/")[:-1]  # Exclude filename
        parent_id = folder_id
        for part_name in parts:
            existing = await db.execute(
                select(Folder).where(
                    Folder.user_id == user.id,
                    Folder.name == part_name,
                    Folder.parent_id == parent_id if parent_id else Folder.parent_id == None,
                    Folder.is_deleted == False,
                )
            )
            folder = existing.scalar_one_or_none()
            if not folder:
                folder = Folder(
                    name=part_name,
                    parent_id=parent_id,
                    user_id=user.id,
                    path=f"/{part_name}",
                )
                db.add(folder)
                await db.flush()
                await db.refresh(folder)
            parent_id = folder.id
        actual_folder_id = parent_id

    # Check if file with same original_name exists
    original_name = file.filename or "unnamed"
    if actual_folder_id:
        existing_file_query = select(File).where(
            File.user_id == user.id,
            File.folder_id == actual_folder_id,
            File.original_name == original_name,
            File.is_deleted == False,
        )
    else:
        existing_file_query = select(File).where(
            File.user_id == user.id,
            File.folder_id == None,
            File.original_name == original_name,
            File.is_deleted == False,
        )
    
    existing = await db.execute(existing_file_query)
    existing_file = existing.scalar_one_or_none()

    if existing_file:
        existing_file.current_version += 1
        existing_file.minio_key = minio_key
        existing_file.size = file_size
        existing_file.checksum_sha256 = checksum
        existing_file.mime_type = file.content_type or "application/octet-stream"
        db_file = existing_file
        await db.flush()
        await db.refresh(db_file)
    else:
        db_file = File(
            filename=f"{file_id}{f'.{ext}' if ext else ''}",
            original_name=original_name,
            mime_type=file.content_type or "application/octet-stream",
            size=file_size,
            folder_id=actual_folder_id,
            user_id=user.id,
            minio_bucket=settings.MINIO_BUCKET_FILES,
            minio_key=minio_key,
            checksum_sha256=checksum,
        )
        db.add(db_file)
        await db.flush()
        await db.refresh(db_file)

    # Create new version record
    version = FileVersion(
        file_id=db_file.id,
        version_number=db_file.current_version,
        minio_key=minio_key,
        size=file_size,
        checksum_sha256=checksum,
        uploaded_by=user.id,
    )
    db.add(version)

    # Update storage used (accumulate size of all versions)
    user.storage_used += file_size
    await db.commit()

    # Emit Kafka event
    await _emit_event("FILE_UPLOADED", {
        "file_id": db_file.id,
        "user_id": user.id,
        "filename": db_file.original_name,
        "mime_type": db_file.mime_type,
        "size": file_size,
        "minio_key": minio_key,
    })

    return _file_to_dict(db_file)



async def verify_file_access(db: AsyncSession, file_id: str, user_id: str, required_role: str = "viewer") -> File:
    # 1. Fetch file and its folder
    f_query = select(File, Folder).outerjoin(Folder, File.folder_id == Folder.id).where(File.id == file_id, File.is_deleted == False)
    result = await db.execute(f_query)
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="File not found")
    
    file_obj, folder_obj = row

    # 2. If owner, always allow
    if file_obj.user_id == user_id:
        return file_obj

    # 3. If file is in a folder, check inherited permissions
    if folder_obj:
        # Walk the actual parent chain. Folder.path contains names, not IDs.
        folder_ids_to_check = [folder_obj.id]
        parent_id = folder_obj.parent_id
        visited = set(folder_ids_to_check)
        while parent_id and parent_id not in visited:
            visited.add(parent_id)
            folder_ids_to_check.append(parent_id)
            parent_row = await db.execute(
                select(Folder.id, Folder.parent_id).where(Folder.id == parent_id)
            )
            parent = parent_row.first()
            if not parent:
                break
            parent_id = parent.parent_id
        
        perm_query = select(FolderPermission).where(
            FolderPermission.folder_id.in_(folder_ids_to_check),
            FolderPermission.user_id == user_id
        )
        perm_res = await db.execute(perm_query)
        perms = perm_res.scalars().all()
        
        if perms:
            # Check if any of the permissions satisfy the required role
            has_access = False
            for p in perms:
                if required_role == "viewer":
                    has_access = True # Any role can view
                    break
                elif required_role == "editor" and p.role in ["editor", "manager"]:
                    has_access = True
                    break
                elif required_role == "manager" and p.role == "manager":
                    has_access = True
                    break
            
            if has_access:
                return file_obj

    raise HTTPException(status_code=403, detail="You do not have permission to access this file")

@app.get("/api/v1/files/{file_id}/download")
async def download_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    f = await verify_file_access(db, file_id, user.id, "viewer")

    # Generate presigned URL (valid for 1 hour)
    from datetime import timedelta
    try:
        response_headers = {"response-content-disposition": f'inline; filename="{f.original_name}"'}
        
        # Force UTF-8 for text files to fix encoding issues in browser preview
        if f.mime_type and f.mime_type.startswith("text/") and "charset" not in f.mime_type:
            response_headers["response-content-type"] = f"{f.mime_type}; charset=utf-8"
            
        url = minio_public_client.presigned_get_object(
            f.minio_bucket,
            f.minio_key,
            expires=timedelta(hours=1),
            response_headers=response_headers,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate download URL: {str(e)}")

    await _emit_event("FILE_DOWNLOADED", {
        "file_id": f.id,
        "user_id": user.id,
        "filename": f.original_name,
    })

    return {"download_url": url}


# ══════════════════════════════════════════════
# VERSIONS
# ══════════════════════════════════════════════

@app.get("/api/v1/files/{file_id}/versions")
async def get_file_versions(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify file exists and belongs to user
    f_result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id, File.is_deleted == False)
    )
    f = f_result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    v_result = await db.execute(
        select(FileVersion).where(FileVersion.file_id == file_id).order_by(FileVersion.version_number.desc())
    )
    versions = v_result.scalars().all()
    
    return [
        {
            "id": v.id,
            "version_number": v.version_number,
            "size": v.size,
            "created_at": v.created_at.isoformat() if v.created_at else None,
            "uploaded_by": v.uploaded_by,
        }
        for v in versions
    ]


@app.post("/api/v1/files/{file_id}/versions/restore")
async def restore_file_version(
    file_id: str,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    version_number = body.get("version_number")
    if not version_number:
        raise HTTPException(status_code=400, detail="version_number is required")

    # Verify file exists and belongs to user
    f_result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id, File.is_deleted == False)
    )
    f = f_result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    # Get target version
    v_result = await db.execute(
        select(FileVersion).where(
            FileVersion.file_id == file_id, 
            FileVersion.version_number == version_number
        )
    )
    target_version = v_result.scalar_one_or_none()
    if not target_version:
        raise HTTPException(status_code=404, detail="Version not found")
        
    if target_version.version_number == f.current_version:
        raise HTTPException(status_code=400, detail="Cannot restore to the current version")

    # Increment current_version, update file to match target_version
    f.current_version += 1
    f.minio_key = target_version.minio_key
    f.size = target_version.size
    f.checksum_sha256 = target_version.checksum_sha256
    
    # Store this restoration as a new version
    new_version = FileVersion(
        file_id=f.id,
        version_number=f.current_version,
        minio_key=f.minio_key,
        size=f.size,
        checksum_sha256=f.checksum_sha256,
        uploaded_by=user.id,
    )
    db.add(new_version)
    await db.commit()

    return {"message": f"Restored to version {version_number} successfully as version {f.current_version}"}


# ══════════════════════════════════════════════
# TRASH / DELETE / RESTORE
# ══════════════════════════════════════════════

@app.delete("/api/v1/files/{file_id}")
async def soft_delete_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id, File.is_deleted == False)
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    f.is_deleted = True
    f.deleted_at = datetime.now(timezone.utc)
    await db.commit()

    await _emit_event("FILE_DELETED", {
        "file_id": f.id, "user_id": user.id, "filename": f.original_name,
    })

    return {"detail": "File moved to trash"}


@app.get("/api/v1/files/trash/list")
async def list_trash(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File)
        .where(File.user_id == user.id, File.is_deleted == True)
        .order_by(File.deleted_at.desc())
    )
    files = result.scalars().all()
    return {"files": [_file_to_dict(f) for f in files]}


@app.delete("/api/v1/files/{file_id}/permanent")
async def permanent_delete(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id, File.is_deleted == True)
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found in trash")

    versions_result = await db.execute(
        select(FileVersion).where(FileVersion.file_id == file_id)
    )
    versions = versions_result.scalars().all()

    # A restored version may reference an existing object, so count/delete each
    # physical object only once.
    stored_objects = {version.minio_key: version.size for version in versions}
    stored_objects.setdefault(f.minio_key, f.size)

    # Delete from MinIO
    try:
        for object_key in stored_objects:
            await asyncio.to_thread(minio_client.remove_object, f.minio_bucket, object_key)
        if f.thumbnail_key:
            await asyncio.to_thread(
                minio_client.remove_object,
                settings.MINIO_BUCKET_THUMBNAILS,
                f.thumbnail_key,
            )
    except Exception:
        pass

    # Update storage
    user.storage_used = max(0, user.storage_used - sum(stored_objects.values()))

    await db.delete(f)
    await db.commit()

    return {"detail": "File permanently deleted"}


@app.post("/api/v1/files/{file_id}/restore")
async def restore_file(
    file_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id, File.is_deleted == True)
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found in trash")

    f.is_deleted = False
    f.deleted_at = None
    await db.commit()

    await _emit_event("FILE_RESTORED", {
        "file_id": f.id, "user_id": user.id, "filename": f.original_name,
    })

    return _file_to_dict(f)


# ══════════════════════════════════════════════
# COPY / MOVE
# ══════════════════════════════════════════════

@app.post("/api/v1/files/{file_id}/copy")
async def copy_file(
    file_id: str,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id, File.is_deleted == False)
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    # Copy object in MinIO
    new_id = str(uuid.uuid4())
    ext = f.filename.rsplit(".", 1)[-1] if "." in f.filename else ""
    new_key = f"{user.id}/{new_id}{f'.{ext}' if ext else ''}"

    import io
    try:
        data = minio_client.get_object(f.minio_bucket, f.minio_key)
        content = data.read()
        data.close()
        minio_client.put_object(
            settings.MINIO_BUCKET_FILES,
            new_key,
            io.BytesIO(content),
            length=len(content),
            content_type=f.mime_type,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to copy file: {str(e)}")

    new_file = File(
        filename=f"{new_id}{f'.{ext}' if ext else ''}",
        original_name=f"Copy of {f.original_name}",
        mime_type=f.mime_type,
        size=f.size,
        folder_id=body.get("folder_id") or f.folder_id,
        user_id=user.id,
        minio_bucket=settings.MINIO_BUCKET_FILES,
        minio_key=new_key,
        checksum_sha256=f.checksum_sha256,
    )
    db.add(new_file)

    user.storage_used += f.size
    await db.commit()
    await db.refresh(new_file)

    await _emit_event("FILE_COPIED", {
        "file_id": new_file.id, "source_id": f.id, "user_id": user.id,
    })

    return _file_to_dict(new_file)


@app.post("/api/v1/files/{file_id}/move")
async def move_file(
    file_id: str,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(File).where(File.id == file_id, File.user_id == user.id, File.is_deleted == False)
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")

    new_folder_id = body.get("folder_id")
    if new_folder_id:
        # Verify folder exists
        folder_result = await db.execute(
            select(Folder).where(Folder.id == new_folder_id, Folder.user_id == user.id)
        )
        if not folder_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Destination folder not found")

    f.folder_id = new_folder_id
    await db.commit()
    await db.refresh(f)

    await _emit_event("FILE_MOVED", {
        "file_id": f.id, "user_id": user.id, "folder_id": new_folder_id,
    })

    return _file_to_dict(f)


# ══════════════════════════════════════════════
# FOLDERS
# ══════════════════════════════════════════════

@app.post("/api/v1/folders", status_code=201)
async def create_folder(
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    name = body.get("name")
    if not name:
        raise HTTPException(status_code=400, detail="Folder name is required")

    parent_id = body.get("parent_id")
    path = f"/{name}"
    depth = 0

    if parent_id:
        parent_result = await db.execute(
            select(Folder).where(Folder.id == parent_id, Folder.user_id == user.id)
        )
        parent = parent_result.scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=404, detail="Parent folder not found")
        path = f"{parent.path}/{name}"
        depth = parent.depth + 1

    folder = Folder(
        name=name,
        parent_id=parent_id,
        user_id=user.id,
        path=path,
        depth=depth,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)

    return {
        "id": folder.id,
        "name": folder.name,
        "parent_id": folder.parent_id,
        "path": folder.path,
        "depth": folder.depth,
        "created_at": folder.created_at.isoformat() if folder.created_at else None,
    }


@app.get("/api/v1/folders")
async def list_folders(
    parent_id: str = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(Folder).where(
        Folder.user_id == user.id, Folder.is_deleted == False
    )
    if parent_id:
        query = query.where(Folder.parent_id == parent_id)
    else:
        query = query.where(Folder.parent_id == None)

    query = query.order_by(Folder.name.asc())
    result = await db.execute(query)
    folders = result.scalars().all()

    return {
        "folders": [
            {
                "id": f.id,
                "name": f.name,
                "parent_id": f.parent_id,
                "path": f.path,
                "depth": f.depth,
                "created_at": f.created_at.isoformat() if f.created_at else None,
            }
            for f in folders
        ]
    }

from app.models import FolderPermission

class ShareFolderRequest(BaseModel):
    user_email: str
    role: str # 'viewer', 'editor', 'manager'

@app.post("/api/v1/folders/{folder_id}/share")
async def share_folder(
    folder_id: str,
    req: ShareFolderRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify folder ownership
    query = select(Folder).where(Folder.id == folder_id, Folder.user_id == user.id)
    folder = (await db.execute(query)).scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found or you don't have permission")

    # Find user by email
    user_query = select(User).where(User.email == req.user_email)
    target_user = (await db.execute(user_query)).scalar_one_or_none()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    if target_user.id == user.id:
        raise HTTPException(status_code=400, detail="Cannot share with yourself")

    # Check if permission already exists
    perm_query = select(FolderPermission).where(
        FolderPermission.folder_id == folder_id,
        FolderPermission.user_id == target_user.id
    )
    perm = (await db.execute(perm_query)).scalar_one_or_none()

    if perm:
        perm.role = req.role
    else:
        perm = FolderPermission(
            folder_id=folder_id,
            user_id=target_user.id,
            role=req.role
        )
        db.add(perm)

    await db.commit()

    # Emit notification event
    await _emit_event("FOLDER_SHARED", {
        "folder_id": folder_id,
        "folder_name": folder.name,
        "shared_by": user.id,
        "shared_with": target_user.id,
        "role": req.role
    })

    return {"message": "Folder shared successfully"}

@app.get("/api/v1/folders/shared-with-me")
async def list_shared_folders(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Get all root shared folders
    query = select(Folder).join(FolderPermission, Folder.id == FolderPermission.folder_id).where(
        FolderPermission.user_id == user.id,
        Folder.is_deleted == False
    )
    result = await db.execute(query)
    folders = result.scalars().all()

    return {
        "folders": [
            {
                "id": f.id,
                "name": f.name,
                "parent_id": f.parent_id,
                "path": f.path,
                "depth": f.depth,
                "created_at": f.created_at.isoformat() if f.created_at else None,
            }
            for f in folders
        ]
    }
