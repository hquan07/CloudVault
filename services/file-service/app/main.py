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

import hashlib
import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import jwt as pyjwt
import redis.asyncio as aioredis
from aiokafka import AIOKafkaProducer
from fastapi import FastAPI, Depends, HTTPException, Header, Query, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from minio import Minio
from prometheus_fastapi_instrumentator import Instrumentator
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import User, File, Folder, FileVersion

# ── Global clients ──
minio_client: Minio | None = None
minio_public_client: Minio | None = None
kafka_producer: AIOKafkaProducer | None = None
redis_client: aioredis.Redis | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global minio_client, minio_public_client, kafka_producer, redis_client

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

    yield

    if kafka_producer:
        await kafka_producer.stop()
    if redis_client:
        await redis_client.aclose()


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


# ── Health Check ──

@app.get("/health")
async def health():
    return {"status": "ok", "service": "file"}


# ══════════════════════════════════════════════
# FILE UPLOAD / DOWNLOAD
# ══════════════════════════════════════════════

import asyncio
import io

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
from pydantic import BaseModel

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
