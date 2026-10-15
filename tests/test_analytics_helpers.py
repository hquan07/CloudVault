import importlib.util
import unittest
from datetime import date, datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "services/metadata-service/app/analytics.py"
SPEC = importlib.util.spec_from_file_location("cloudvault_analytics", MODULE_PATH)
analytics = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(analytics)


class AnalyticsHelperTests(unittest.TestCase):
    def test_file_type_summary_uses_real_mime_buckets(self):
        result = analytics.summarize_file_types([
            ("image/png", 2),
            ("application/pdf", 3),
            ("application/zip", 1),
            (None, 4),
        ])
        self.assertEqual(
            {item["name"]: item["value"] for item in result},
            {"Images": 2, "Documents": 3, "Archives": 1, "Others": 4},
        )

    def test_upload_activity_has_six_four_hour_buckets(self):
        now = datetime(2026, 10, 15, 12, 30)
        result = analytics.build_upload_activity([
            ("2026-10-14 13:00:00", 2),
            ("2026-10-15 11:00:00", 3),
        ], now)
        self.assertEqual(len(result), 6)
        self.assertEqual(sum(item["uploads"] for item in result), 5)

    def test_storage_growth_reconstructs_recent_totals(self):
        result = analytics.build_storage_growth(
            100,
            [(date(2026, 10, 14), 20), (date(2026, 10, 15), 30)],
            date(2026, 10, 15),
            days=3,
        )
        self.assertEqual([item["storage_bytes"] for item in result], [50, 70, 100])

    def test_endpoint_and_ui_contract_do_not_fall_back_to_mock_data(self):
        backend = (ROOT / "services/metadata-service/app/main.py").read_text()
        frontend = (ROOT / "frontend/src/app/dashboard/analytics/page.tsx").read_text()
        nginx = (ROOT / "infrastructure/nginx/conf.d/default.conf").read_text()

        self.assertIn('@app.get("/api/v1/analytics/stats")', backend)
        self.assertIn("ProjectMembership.user_id == user.id", backend)
        self.assertIn("File.project_id.in_(project_ids)", backend)
        self.assertNotIn("mockFileTypeData", frontend)
        self.assertNotIn("mockUploadActivity", frontend)
        self.assertIn("location /api/v1/analytics/", nginx)


if __name__ == "__main__":
    unittest.main()
