from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_metadata_list_only_filters_root_when_explicitly_requested():
    source = (ROOT / "services/metadata-service/app/main.py").read_text()

    assert 'elif folder_id == "root":' in source
    assert 'folder_id == "root" or folder_id is None' not in source


def test_file_browser_explicitly_requests_root_but_starred_is_aggregate():
    browser = (ROOT / "frontend/src/app/dashboard/page.tsx").read_text()
    starred = (ROOT / "frontend/src/app/dashboard/starred/page.tsx").read_text()

    assert "folder_id: currentFolderId || 'root'" in browser
    assert "metaApi.listFiles({ is_starred: true" in starred
    assert "folder_id:" not in starred


def test_file_actions_remain_visible_without_hover_on_small_screens():
    browser = (ROOT / "frontend/src/app/dashboard/page.tsx").read_text()
    starred = (ROOT / "frontend/src/app/dashboard/starred/page.tsx").read_text()

    responsive_actions = (
        "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 "
        "sm:group-focus-within:opacity-100"
    )
    assert responsive_actions in browser
    assert responsive_actions in starred
