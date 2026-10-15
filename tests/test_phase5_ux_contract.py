import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class Phase5UxContractTests(unittest.TestCase):
    def test_mobile_navigation_has_accessible_drawer_controls(self):
        source = (ROOT / "frontend/src/app/dashboard/layout.tsx").read_text()
        self.assertIn('aria-controls="mobile-dashboard-navigation"', source)
        self.assertIn("event.key === 'Escape'", source)
        self.assertIn("document.body.style.overflow = 'hidden'", source)

    def test_project_upload_keeps_folder_and_queue_controls(self):
        source = (ROOT / "frontend/src/components/ProjectUploadQueue.tsx").read_text()
        self.assertIn("webkitdirectory", source)
        self.assertIn("Overall {summary.progress}%", source)
        self.assertIn("Cancel active uploads", source)
        self.assertIn("idempotencyKey", source)

    def test_project_scoped_operations_and_integrations_remain_nested(self):
        source = (ROOT / "frontend/src/app/dashboard/projects/[projectId]/page.tsx").read_text()
        self.assertIn("Health / Operations", source)
        self.assertIn("label: 'Integrations'", source)
        self.assertIn("tab === 'integrations' && isAdmin", source)

    def test_search_preserves_project_scope(self):
        frontend = (ROOT / "frontend/src/app/dashboard/search/page.tsx").read_text()
        backend = (ROOT / "services/metadata-service/app/main.py").read_text()
        self.assertIn("params.set('project', projectScope)", frontend)
        self.assertIn("projectId: projectScope === 'personal' ? undefined : projectScope", frontend)
        self.assertIn("ProjectMembership.project_id == project.id", backend)


if __name__ == "__main__":
    unittest.main()
