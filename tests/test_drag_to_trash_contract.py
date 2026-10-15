from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_personal_drive_exposes_internal_drag_to_trash():
    source = (ROOT / "frontend/src/app/dashboard/page.tsx").read_text()

    assert "application/x-cloudvault-item" in source
    assert "handleTrashDrop" in source
    assert "Move folder to Trash?" in source
    assert "Only empty folders can be moved" in source


def test_project_drive_exposes_internal_drag_to_trash():
    source = (ROOT / "frontend/src/app/dashboard/projects/[projectId]/page.tsx").read_text()

    assert "handleItemDragStart" in source
    assert "handleTrashDrop" in source
    assert "Move to project trash" in source
    assert "trashFolders" in source


def test_folder_trash_lifecycle_is_recoverable():
    backend = (ROOT / "services/file-service/app/main.py").read_text()

    for route in (
        '@app.delete("/api/v1/folders/{folder_id}")',
        '@app.post("/api/v1/folders/{folder_id}/restore")',
        '@app.delete("/api/v1/folders/{folder_id}/permanent")',
        '@app.post("/api/v1/projects/{project_id}/folders/{folder_id}/restore")',
        '@app.delete("/api/v1/projects/{project_id}/folders/{folder_id}/permanent")',
    ):
        assert route in backend

    assert '"folders": [_personal_folder_to_dict(folder) for folder in folders]' in backend
    assert '"folders": [_project_folder_to_dict(folder) for folder in folders]' in backend
